import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { s3Stub } from "./stubs/s3.js";
import { supabaseStub } from "./stubs/supabase.js";

let env = {};
let handler;
globalThis.Deno = {
  env: { get: (name) => env[name] },
  serve: (fn) => { handler = fn; }
};

await import("../supabase/functions/cleanup-storage/index.ts");

async function call() {
  const res = await handler(new Request("http://localhost/cleanup-storage", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  env = {
    SUPABASE_URL: "https://mock.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "mock-key",
    R2_ACCOUNT_ID: "mock-account-id",
    R2_ACCESS_KEY_ID: "mock-access-key",
    R2_SECRET_ACCESS_KEY: "mock-secret-key",
    R2_BUCKET_NAME: "handoff-files"
  };
  s3Stub.reset();
  supabaseStub.reset();
  for (const level of ["log", "info", "warn", "error"]) console[level] = () => {};
});

test("cleanup-storage purges R2 objects older than 15 minutes", async () => {
  const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const fetched = [];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes("mock-list")) {
      const xml = `<ListBucketResult>
        <Contents><Key>room1/expired.pdf</Key><LastModified>${twentyMinsAgo}</LastModified></Contents>
        <Contents><Key>room2/fresh.png</Key><LastModified>${fiveMinsAgo}</LastModified></Contents>
      </ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 204 });
  };

  const res = await call();

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.r2.deletedCount, 1);

  // Assert DeleteObject was signed and fetched with DELETE for the expired key
  assert.ok(s3Stub.signed.some((s) => s.command.input?.Key === "room1/expired.pdf"));
  assert.ok(!s3Stub.signed.some((s) => s.command.input?.Key === "room2/fresh.png"));
  assert.ok(fetched.some((f) => f.opts?.method === "DELETE" && f.url.includes("room1/expired.pdf")));
});

test("cleanup-storage does nothing when R2 has no expired objects", async () => {
  const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const fetched = [];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes("mock-list")) {
      const xml = `<ListBucketResult>
        <Contents><Key>room1/brand-new.pdf</Key><LastModified>${twoMinsAgo}</LastModified></Contents>
      </ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 204 });
  };

  const res = await call();

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.r2.deletedCount, 0);

  // Assert no delete commands or delete fetches
  assert.ok(!s3Stub.signed.some((s) => s.command.type === "DeleteObject"));
  assert.ok(!fetched.some((f) => f.opts?.method === "DELETE"));
});

test("cleanup-storage reads every page of the listing", async () => {
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const fetched = [];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes("mock-list-uploads")) return new Response("<ListMultipartUploadsResult></ListMultipartUploadsResult>", { status: 200 });
    if (url.includes("mock-list") && !url.includes("continuation-token")) {
      return new Response(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken>
        <Contents><Key>room1/a.pdf</Key><LastModified>${old}</LastModified></Contents></ListBucketResult>`, { status: 200 });
    }
    if (url.includes("mock-list")) {
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>
        <Contents><Key>room9/b.pdf</Key><LastModified>${old}</LastModified></Contents></ListBucketResult>`, { status: 200 });
    }
    return new Response(null, { status: 204 });
  };

  const res = await call();
  assert.equal(res.json.r2.deletedCount, 2);
  assert.ok(fetched.some((f) => f.opts?.method === "DELETE" && f.url.includes("room9/b.pdf")), "object on page 2 deleted");
});

test("cleanup-storage aborts multipart uploads abandoned for over 6 hours", async () => {
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const fetched = [];
  globalThis.fetch = async (url, opts) => {
    fetched.push({ url, opts });
    if (url.includes("mock-list-uploads")) {
      return new Response(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>
        <Upload><Key>room1/old.bin</Key><UploadId>up-old</UploadId><Initiated>${sevenHoursAgo}</Initiated></Upload>
        <Upload><Key>room2/active.bin</Key><UploadId>up-new</UploadId><Initiated>${tenMinsAgo}</Initiated></Upload>
      </ListMultipartUploadsResult>`, { status: 200 });
    }
    if (url.includes("mock-list")) return new Response("<ListBucketResult></ListBucketResult>", { status: 200 });
    return new Response(null, { status: 204 });
  };

  const res = await call();
  assert.equal(res.json.r2.abortedUploads, 1);
  const aborts = s3Stub.signed.filter((s) => s.command.type === "AbortMultipartUpload").map((s) => s.command.input.UploadId);
  assert.deepEqual(aborts, ["up-old"]);
});
