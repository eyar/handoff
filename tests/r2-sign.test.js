import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { s3Stub } from "./stubs/s3.js";

let env = {};
let handler;
globalThis.Deno = {
  env: { get: (name) => env[name] },
  serve: (fn) => { handler = fn; }
};

await import("../supabase/functions/r2-sign/index.ts");

const ROOM = "abc123def4";

async function call(body, { method = "POST" } = {}) {
  const res = await handler(new Request("http://localhost/r2-sign", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let fetched = [];

beforeEach(() => {
  env = {
    R2_ACCOUNT_ID: "mock-account-id",
    R2_ACCESS_KEY_ID: "mock-access-key",
    R2_SECRET_ACCESS_KEY: "mock-secret-key",
    R2_BUCKET_NAME: "handoff-files"
  };
  s3Stub.reset();
  fetched = [];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    return new Response(null, { status: 204 });
  };
  for (const level of ["log", "info", "warn", "error"]) console[level] = () => {};
});

test("non-POST methods are rejected", async () => {
  assert.equal((await call(null, { method: "GET" })).status, 405);
});

test("roomId is validated", async () => {
  assert.equal((await call({ roomId: "short" })).status, 400);
});

test("upload action generates both presigned PUT and GET URLs", async () => {
  const res = await call({
    action: "upload",
    roomId: ROOM,
    fileName: "video.mp4",
    fileId: "123",
    mimeType: "video/mp4",
    fileSize: 50 * 1024 * 1024
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.match(res.json.uploadUrl, /handoff-files\.r2\.cloudflarestorage\.com/);
  assert.match(res.json.downloadUrl, /handoff-files\.r2\.cloudflarestorage\.com/);
  assert.equal(res.json.storagePath, `${ROOM}/123-video.mp4`);
  assert.equal(s3Stub.signed.length, 2);
});

test("files over 1.5 GB are rejected", async () => {
  const res = await call({
    action: "upload",
    roomId: ROOM,
    fileName: "huge.zip",
    fileSize: 1.6 * 1024 * 1024 * 1024
  });

  assert.equal(res.status, 400);
  assert.match(res.json.error, /exceeds 1\.5 GB/);
});

test("delete action removes objects from R2", async () => {
  const res = await call({
    action: "delete",
    roomId: ROOM,
    paths: [`${ROOM}/123-file.pdf`]
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.count, 1);
  assert.equal(s3Stub.signed.length, 1);
  assert.equal(s3Stub.signed[0].command.type, "DeleteObject");
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].opts.method, "DELETE");
});

test("delete action refuses paths from another room", async () => {
  const res = await call({
    action: "delete",
    roomId: ROOM,
    paths: ["otherroom1/123-file.pdf"]
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.count, 0);
  assert.equal(s3Stub.signed.length, 0);
  assert.equal(fetched.length, 0);
});

test("delete-room action lists and deletes all room objects from R2", async () => {
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes("mock-list")) {
      const xml = `<ListBucketResult>
        <Contents><Key>${ROOM}/1-pic.jpg</Key></Contents>
        <Contents><Key>${ROOM}/2-doc.pdf</Key></Contents>
      </ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 204 });
  };

  const res = await call({
    action: "delete-room",
    roomId: ROOM
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.count, 2);
  assert.equal(s3Stub.signed.length, 3);
  assert.equal(s3Stub.signed[0].command.type, "ListObjectsV2");
  assert.equal(s3Stub.signed[1].command.type, "DeleteObject");
  assert.equal(s3Stub.signed[2].command.type, "DeleteObject");
  assert.equal(fetched.length, 3);
  assert.equal(fetched[1].opts.method, "DELETE");
  assert.equal(fetched[2].opts.method, "DELETE");
});

// ---------- Multipart (chunked end-to-end encrypted uploads) ----------

function mockR2(handlers) {
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    const op = new URL(url).searchParams.get("op");
    return handlers[op] ? handlers[op](url, opts) : new Response("", { status: 200 });
  };
}

test("multipart-create starts an upload in the room's folder and returns a download URL", async () => {
  mockR2({ CreateMultipartUpload: () => new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>") });
  const res = await call({ action: "multipart-create", roomId: ROOM, fileName: "big video.mov", fileId: "f1", fileSize: 500 * 1024 * 1024 });
  assert.equal(res.status, 200);
  assert.equal(res.json.uploadId, "up-1");
  assert.equal(res.json.storagePath, `${ROOM}/f1-big_video.mov`);
  assert.ok(res.json.downloadUrl.includes("mock-get"));
  assert.equal(fetched[0].opts.method, "POST");
});

test("multipart-create rejects files over the size limit", async () => {
  const res = await call({ action: "multipart-create", roomId: ROOM, fileName: "x", fileId: "f1", fileSize: 2 * 1024 * 1024 * 1024 });
  assert.equal(res.status, 400);
});

test("multipart-sign-parts signs requested parts and validates part numbers", async () => {
  const ok = await call({ action: "multipart-sign-parts", roomId: ROOM, storagePath: `${ROOM}/f1-a.bin`, uploadId: "up-1", partNumbers: [1, 2, 3] });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json.urls), ["1", "2", "3"]);
  assert.ok(ok.json.urls["2"].includes("partNumber=2"));

  for (const partNumbers of [[], [0], [10001], [1.5], Array.from({ length: 51 }, (_, i) => i + 1)]) {
    const bad = await call({ action: "multipart-sign-parts", roomId: ROOM, storagePath: `${ROOM}/f1-a.bin`, uploadId: "up-1", partNumbers });
    assert.equal(bad.status, 400, `partNumbers ${JSON.stringify(partNumbers).slice(0, 20)}`);
  }
});

test("multipart actions refuse another room's files", async () => {
  for (const action of ["multipart-sign-parts", "multipart-complete", "multipart-abort"]) {
    const res = await call({ action, roomId: ROOM, storagePath: "otherroom1/f1-a.bin", uploadId: "up-1", partNumbers: [1], partCount: 1 });
    assert.equal(res.status, 400, action);
  }
  const traversal = await call({ action: "multipart-abort", roomId: ROOM, storagePath: `${ROOM}/../otherroom1/x`, uploadId: "up-1" });
  assert.equal(traversal.status, 400);
});

test("multipart-complete reads ETags from R2 and completes with every part in order", async () => {
  let completeBody = null;
  mockR2({
    // Real R2 escapes the quotes around ETags in ListParts XML
    ListParts: () => new Response(`<ListPartsResult><IsTruncated>false</IsTruncated>
      <Part><PartNumber>2</PartNumber><ETag>&quot;bbb&quot;</ETag></Part>
      <Part><PartNumber>1</PartNumber><ETag>&quot;aaa&quot;</ETag></Part></ListPartsResult>`),
    CompleteMultipartUpload: (url, opts) => {
      completeBody = opts.body;
      return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    },
  });
  const res = await call({ action: "multipart-complete", roomId: ROOM, storagePath: `${ROOM}/f1-a.bin`, uploadId: "up-1", partCount: 2 });
  assert.equal(res.status, 200);
  assert.equal(completeBody, '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part></CompleteMultipartUpload>');
});

test("multipart-complete refuses to finish an upload with missing parts", async () => {
  mockR2({ ListParts: () => new Response(`<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part><Part><PartNumber>3</PartNumber><ETag>"c"</ETag></Part></ListPartsResult>`) });
  const res = await call({ action: "multipart-complete", roomId: ROOM, storagePath: `${ROOM}/f1-a.bin`, uploadId: "up-1", partCount: 3 });
  assert.equal(res.status, 409);
  assert.ok(!fetched.some((f) => f.url.includes("op=CompleteMultipartUpload")));
});

test("multipart-complete treats an R2 200-with-<Error> response as a failure", async () => {
  mockR2({
    ListParts: () => new Response(`<ListPartsResult><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part></ListPartsResult>`),
    CompleteMultipartUpload: () => new Response("<Error><Code>InvalidPart</Code></Error>", { status: 200 }),
  });
  const res = await call({ action: "multipart-complete", roomId: ROOM, storagePath: `${ROOM}/f1-a.bin`, uploadId: "up-1", partCount: 1 });
  assert.equal(res.status, 500);
});
