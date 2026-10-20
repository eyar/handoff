import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { supabaseStub } from "./stubs/supabase.js";
import { s3Stub } from "./stubs/s3.js";

let env = {};
let handler;
globalThis.Deno = {
  env: { get: (name) => env[name] },
  serve: (fn) => { handler = fn; }
};

await import("../supabase/functions/shortcut-upload/index.ts");

const ROOM = "abc123def4";
const MB = 1024 * 1024;
const realFetch = globalThis.fetch;
let r2Uploads;
let broadcasts;

async function upload({ size, room, withLength = true, uploadStatus = 200, fileName = "clip.mov", mimeType = "video/quicktime" } = {}) {
  globalThis.fetch = async (url, init) => {
    if (url.includes(".r2.cloudflarestorage.com")) {
      r2Uploads.push({ url, method: init?.method, headers: init?.headers });
      return new Response("{}", { status: uploadStatus });
    }
    if (url.includes("/realtime/v1/api/broadcast")) {
      broadcasts.push(JSON.parse(init.body).messages[0]);
      return new Response("{}");
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const headers = { "Content-Type": mimeType };
  if (fileName !== null) headers["x-file-name"] = fileName;
  if (withLength) headers["Content-Length"] = String(size);
  if (room) headers["x-room-id"] = room;
  const res = await handler(new Request("http://localhost/shortcut-upload", {
    method: "POST",
    headers,
    body: withLength ? "" : "x"
  }));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  env = {
    SUPABASE_URL: "https://test-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    R2_ACCOUNT_ID: "mock-account-id",
    R2_ACCESS_KEY_ID: "mock-access-key",
    R2_SECRET_ACCESS_KEY: "mock-secret-key",
    R2_BUCKET_NAME: "handoff-files"
  };
  supabaseStub.reset();
  s3Stub.reset();
  r2Uploads = [];
  broadcasts = [];
  for (const level of ["log", "info", "warn", "error"]) console[level] = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a staged upload streams directly to R2 and returns a download URL", async () => {
  const res = await upload({ size: 50 * MB });
  assert.equal(res.json.success, true);
  assert.equal(res.json.staged, true);
  assert.equal(r2Uploads.length, 1);
  assert.equal(r2Uploads[0].method, "PUT");
  assert.match(r2Uploads[0].url, /r2\.cloudflarestorage\.com/);
  assert.match(res.json.downloadUrl, /r2\.cloudflarestorage\.com/);
});

test("a large file (500 MB) uploads directly to R2 without being held", async () => {
  const res = await upload({ size: 500 * MB, room: ROOM });
  assert.equal(res.json.success, true);
  assert.equal(res.json.held, undefined);
  assert.equal(broadcasts[0].event, "file:ready");
  assert.match(broadcasts[0].payload.downloadUrl, /r2\.cloudflarestorage\.com/);
  assert.equal(broadcasts[0].payload.size, 500 * MB);
});

test("uploads over 1.5 GB are rejected before touching storage", async () => {
  const res = await upload({ size: 1600 * MB });
  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
  assert.equal(r2Uploads.length, 0);
});

test("a failed R2 upload returns an error response", async () => {
  const res = await upload({ size: 50 * MB, uploadStatus: 500 });
  assert.equal(res.status, 500);
  assert.match(res.json.error, /Storage upload failed/);
});

test("an unnamed QuickTime video gets a .mov name, not .quicktime", async () => {
  const res = await upload({ size: 50 * MB, fileName: null });
  assert.match(res.json.fileName, /^shared-file-\d+\.mov$/);
  assert.match(r2Uploads[0].url, /\.mov/);
});

test("unnamed uploads get the usual extension for their MIME type", async () => {
  const cases = {
    "image/jpeg": "jpg",
    "image/heic": "heic",
    "audio/x-m4a": "m4a",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/octet-stream": "bin",
    "application/vnd.some-unknown-long-type": "bin"
  };
  for (const [mimeType, ext] of Object.entries(cases)) {
    const res = await upload({ size: MB, fileName: null, mimeType });
    assert.match(res.json.fileName, new RegExp(`\\.${ext}$`), mimeType);
  }
});

test("a name without an extension gets one from the MIME type; a name with one is kept", async () => {
  assert.equal((await upload({ size: MB, fileName: "IMG_1234" })).json.fileName, "IMG_1234.mov");
  assert.equal((await upload({ size: MB, fileName: "IMG_1234.MOV" })).json.fileName, "IMG_1234.MOV");
  assert.equal((await upload({ size: MB, fileName: "report.pdf", mimeType: "application/pdf" })).json.fileName, "report.pdf");
});
