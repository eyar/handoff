// Anonymous usage counts: how many visits end up paired, and whether transfers go through.
// Each row is an event name plus a few coarse buckets. No room id, key, IP, user agent, file name or exact size.
import { supabase } from "./supabaseClient.js";

// One visit per browser tab, so a reload or a restored session isn't counted twice
const VISIT_KEY = "handoff_usage_visit";

const GUIDE_PATHS = new Set([
  "/airdrop-for-windows",
  "/android-to-mac",
  "/computer-to-computer",
  "/iphone-to-android",
  "/iphone-to-pc",
  "/send-to-any-computer"
]);

export function sizeBucket(bytes) {
  const MB = 1024 * 1024;
  if (bytes < MB) return "<1MB";
  if (bytes < 10 * MB) return "1-10MB";
  if (bytes < 100 * MB) return "10-100MB";
  if (bytes < 1024 * MB) return "100MB-1GB";
  return ">1GB";
}

export function waitBucket(ms) {
  if (ms < 30_000) return "<30s";
  if (ms < 2 * 60_000) return "30s-2m";
  if (ms < 10 * 60_000) return "2-10m";
  return ">10m";
}

export function deviceOs(nav = navigator) {
  const ua = nav?.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua) || (nav?.platform === "MacIntel" && nav?.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows|Macintosh|Mac OS X|CrOS|Linux/i.test(ua)) return "desktop";
  return "other";
}

/** Where this visit came from, judged from the landing URL and referrer. */
export function entryPoint({ params, referrer = "", host = "", embedded = false, restored = false }) {
  if (embedded) return "extension";
  if (params.has("staged") || params.has("text") || params.has("url")) return "ios_shortcut";
  if (params.has("shared")) return "android_share";
  if (params.has("room")) return "qr_scan";
  if (restored) return "resume";
  let ref = null;
  try {
    ref = referrer ? new URL(referrer) : null;
  } catch (_) {}
  if (!ref) return "direct";
  if (ref.host !== host) return "referral";
  return GUIDE_PATHS.has(ref.pathname.replace(/\/$/, "")) ? "guide" : "direct";
}

/** Which kinds of device share the room, from this device's role and the other peers' roles. */
export function pairType(role, peers) {
  if (peers.length === 0) return "none";
  const roles = new Set(peers.map((p) => p.role));
  if (role === "computer") return roles.has("computer") ? "computer-computer" : "computer-phone";
  return roles.has("computer") ? "computer-phone" : "phone-phone";
}

function readVisit() {
  try {
    return JSON.parse(sessionStorage.getItem(VISIT_KEY) || "null");
  } catch (_) {
    return null;
  }
}

function saveVisit(visit) {
  try {
    sessionStorage.setItem(VISIT_KEY, JSON.stringify(visit));
  } catch (_) {}
}

function isAutomated() {
  if (typeof navigator === "undefined") return true;
  return Boolean(navigator.webdriver) || /bot|crawl|spider|headless|lighthouse/i.test(navigator.userAgent || "");
}

async function logEvent(event, props) {
  if (isAutomated()) return;
  try {
    await supabase.from("usage_events").insert({ event, props });
  } catch (_) {
    // Non-blocking telemetry
  }
}

/** Counts this tab's visit once, the first time the app opens in it. */
export function startVisit(entry) {
  if (readVisit()) return;
  const visit = { at: Date.now(), entry, os: deviceOs() };
  saveVisit(visit);
  logEvent("visit", { entry, os: visit.os });
}

/** Counts the first time this visit gets another device connected. */
export function markPaired(role, peers) {
  const visit = readVisit();
  if (!visit || visit.paired) return;
  visit.paired = true;
  saveVisit(visit);
  logEvent("paired", {
    entry: visit.entry,
    os: visit.os,
    pair: pairType(role, peers),
    peer_ios: peers.some((p) => p.ios === true),
    wait: waitBucket(Date.now() - visit.at)
  });
}

// Long enough that someone opening a computer's QR link should be paired by then
const UNPAIRED_CHECK_MS = 60_000;

/**
 * A minute into a visit that still hasn't paired, notes whether it's connected to the server, which tells an
 * empty room (an old link, or the other device left) apart from a connection that failed.
 */
export function checkUnpairedLater(isConnected) {
  const visit = readVisit();
  if (!visit || visit.paired || visit.unpaired) return;
  setTimeout(() => {
    const current = readVisit();
    if (!current || current.paired || current.unpaired) return;
    current.unpaired = true;
    saveVisit(current);
    logEvent("unpaired", {
      entry: current.entry,
      os: current.os,
      server: isConnected() ? "connected" : "not_connected"
    });
  }, Math.max(0, visit.at + UNPAIRED_CHECK_MS - Date.now()));
}

/** One row per file sent: ok, failed or cancelled. */
export function logFileTransfer({ role, peers, size, outcome }) {
  logEvent("transfer", {
    kind: "file",
    from: role,
    pair: pairType(role, peers),
    size: sizeBucket(size),
    outcome
  });
}

/** Text syncs as you type, so only the first text a visit sends is counted. */
export function logTextTransfer({ role, peers }) {
  const visit = readVisit();
  // Typing while nobody else is connected isn't a transfer yet
  if (!visit || visit.text || peers.length === 0) return;
  visit.text = true;
  saveVisit(visit);
  logEvent("transfer", { kind: "text", from: role, pair: pairType(role, peers), outcome: "ok" });
}
