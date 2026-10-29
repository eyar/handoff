import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { supabaseStub } from "./stubs/supabase.js";

// usage.js keeps the visit in sessionStorage; give it an in-memory one.
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}
globalThis.sessionStorage = new MemoryStorage();
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1" },
  configurable: true
});

const usage = await import("../public/modules/usage.js");

const MB = 1024 * 1024;
const rows = () => supabaseStub.tables.usage_events || [];
const flush = () => new Promise((resolve) => setImmediate(resolve));
const entry = (search, extra = {}) =>
  usage.entryPoint({ params: new URLSearchParams(search), host: "handoffdrop.app", ...extra });

beforeEach(() => {
  sessionStorage.clear();
  supabaseStub.tables = {};
});

test("buckets never carry exact sizes or times", () => {
  assert.equal(usage.sizeBucket(500 * 1024), "<1MB");
  assert.equal(usage.sizeBucket(5 * MB), "1-10MB");
  assert.equal(usage.sizeBucket(50 * MB), "10-100MB");
  assert.equal(usage.sizeBucket(500 * MB), "100MB-1GB");
  assert.equal(usage.sizeBucket(2048 * MB), ">1GB");
  assert.equal(usage.waitBucket(10_000), "<30s");
  assert.equal(usage.waitBucket(60_000), "30s-2m");
  assert.equal(usage.waitBucket(5 * 60_000), "2-10m");
  assert.equal(usage.waitBucket(60 * 60_000), ">10m");
});

test("entry point comes from the landing URL, then the referrer", () => {
  assert.equal(entry("?room=abc", { embedded: true }), "extension");
  assert.equal(entry("?staged=f1&name=a.jpg"), "ios_shortcut");
  assert.equal(entry("?text=hello"), "ios_shortcut");
  assert.equal(entry("?shared=1"), "android_share");
  assert.equal(entry("?room=abc&from=pc"), "qr_scan");
  assert.equal(entry("", { restored: true }), "resume");
  assert.equal(entry("", { referrer: "https://handoffdrop.app/iphone-to-pc" }), "guide");
  assert.equal(entry("", { referrer: "https://handoffdrop.app/privacy" }), "direct");
  assert.equal(entry("", { referrer: "https://www.reddit.com/r/iphone" }), "referral");
  assert.equal(entry(""), "direct");
});

test("pair type from this device's role and its peers", () => {
  assert.equal(usage.pairType("computer", [{ role: "phone" }]), "computer-phone");
  assert.equal(usage.pairType("computer", [{ role: "computer" }]), "computer-computer");
  assert.equal(usage.pairType("phone", [{ role: "computer" }]), "computer-phone");
  assert.equal(usage.pairType("phone", [{ role: "phone" }]), "phone-phone");
  assert.equal(usage.pairType("phone", []), "none");
});

test("a tab counts one visit and one pairing", async () => {
  usage.startVisit("direct");
  usage.startVisit("direct");
  usage.markPaired("phone", [{ role: "computer", ios: false }]);
  usage.markPaired("phone", [{ role: "computer", ios: false }]);
  await flush();
  assert.deepEqual(rows().map((r) => r.event), ["visit", "paired"]);
  assert.deepEqual(rows()[0].props, { entry: "direct", os: "ios" });
  assert.deepEqual(rows()[1].props, { entry: "direct", os: "ios", pair: "computer-phone", peer_ios: false, wait: "<30s" });
});

test("pairing isn't counted without a visit", async () => {
  usage.markPaired("computer", [{ role: "phone", ios: true }]);
  await flush();
  assert.equal(rows().length, 0);
});

test("file transfers log every file; text only the first send with a peer", async () => {
  usage.startVisit("qr_scan");
  usage.logFileTransfer({ role: "phone", peers: [{ role: "computer" }], size: 3 * MB, outcome: "ok" });
  usage.logTextTransfer({ role: "phone", peers: [] });
  usage.logTextTransfer({ role: "phone", peers: [{ role: "computer" }] });
  usage.logTextTransfer({ role: "phone", peers: [{ role: "computer" }] });
  await flush();
  const transfers = rows().filter((r) => r.event === "transfer").map((r) => r.props);
  assert.deepEqual(transfers, [
    { kind: "file", from: "phone", pair: "computer-phone", size: "1-10MB", outcome: "ok" },
    { kind: "text", from: "phone", pair: "computer-phone", outcome: "ok" }
  ]);
});

test("automated browsers aren't counted", async () => {
  navigator.webdriver = true;
  try {
    usage.startVisit("direct");
    await flush();
    assert.equal(rows().length, 0);
  } finally {
    delete navigator.webdriver;
  }
});

test("only errors from Handoff's own scripts are reported", async () => {
  const { isOwnScript } = await import("../public/modules/diagnostics.js");
  const origin = "https://handoffdrop.app";
  assert.equal(isOwnScript("https://handoffdrop.app/modules/upload.js", origin), true);
  assert.equal(isOwnScript("https://handoffdrop.app/?room=abc&from=pc", origin), false);
  assert.equal(isOwnScript("chrome-extension://abc/userscript.html?name=x.user.js", origin), false);
  assert.equal(isOwnScript("https://cdn.example.com/app.js", origin), false);
  assert.equal(isOwnScript("", origin), false);
});
