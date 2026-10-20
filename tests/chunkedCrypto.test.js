import test from "node:test";
import assert from "node:assert/strict";
import { generateEncryptionKey, encryptFile } from "../public/modules/crypto.js";
import {
  createChunkedEncryptor,
  decryptChunkedStream,
  decryptChunkedToBlob,
  encryptedSize,
  isChunkedFormat,
  HEADER_BYTES,
} from "../public/modules/chunkedCrypto.js";

const CS = 64; // tiny chunks so tests cross many chunk boundaries; first chunk holds CS - 20 = 44 bytes
const FIRST = CS - HEADER_BYTES;

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function encryptToParts(bytes, key) {
  const enc = createChunkedEncryptor(new Blob([bytes]), key, CS);
  const parts = [];
  for (let i = 0; i < enc.count; i++) parts.push(await enc.encryptPart(i));
  return { enc, parts };
}

function streamOf(bytes, pieceSize = 7) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + pieceSize));
      offset += pieceSize;
    },
  });
}

const join = (parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

async function decryptAll(bytes, key, pieceSize) {
  const out = [];
  for await (const chunk of decryptChunkedStream(streamOf(bytes, pieceSize), key)) out.push(chunk);
  return join(out);
}

test("chunked: round-trips every edge size, with uniform part sizes", async () => {
  const key = await generateEncryptionKey();
  const sizes = [0, 1, FIRST - 1, FIRST, FIRST + 1, FIRST + CS - 1, FIRST + CS, FIRST + CS + 1, FIRST + 5 * CS, 1000];
  for (const size of sizes) {
    const plain = randomBytes(size);
    const { enc, parts } = await encryptToParts(plain, key);
    const blob = join(parts);
    assert.equal(blob.byteLength, enc.encryptedSize, `size ${size}: encrypted length`);
    assert.equal(blob.byteLength, encryptedSize(size, CS));
    parts.slice(0, -1).forEach((p, i) => assert.equal(p.byteLength, CS + 16, `size ${size}: part ${i} length`));
    assert.ok(isChunkedFormat(blob));
    assert.deepEqual(await decryptAll(blob, key, 7), plain, `size ${size}: round trip`);
  }
});

test("chunked: works with any network read size (1 byte to whole file)", async () => {
  const key = await generateEncryptionKey();
  const plain = randomBytes(FIRST + 3 * CS + 10);
  const blob = join((await encryptToParts(plain, key)).parts);
  for (const piece of [1, 13, CS + 16, blob.byteLength]) {
    assert.deepEqual(await decryptAll(blob, key, piece), plain, `piece size ${piece}`);
  }
});

test("chunked: decryptChunkedToBlob returns the original bytes and mime type", async () => {
  const key = await generateEncryptionKey();
  const plain = randomBytes(300);
  const blob = join((await encryptToParts(plain, key)).parts);
  const out = await decryptChunkedToBlob(streamOf(blob, 50), key, "image/png");
  assert.equal(out.type, "image/png");
  assert.deepEqual(new Uint8Array(await out.arrayBuffer()), plain);
});

test("chunked: encrypting the same file twice uses a fresh nonce prefix", async () => {
  const key = await generateEncryptionKey();
  const plain = randomBytes(100);
  const a = join((await encryptToParts(plain, key)).parts);
  const b = join((await encryptToParts(plain, key)).parts);
  assert.notDeepEqual(a.slice(12, 20), b.slice(12, 20));
  assert.notDeepEqual(a, b);
});

test("chunked: re-encrypting a part (retry) gives identical bytes", async () => {
  const key = await generateEncryptionKey();
  const enc = createChunkedEncryptor(new Blob([randomBytes(500)]), key, CS);
  assert.deepEqual(await enc.encryptPart(3), await enc.encryptPart(3));
});

async function assertRejects(promiseFactory, label) {
  await assert.rejects(promiseFactory, undefined, label);
}

test("chunked: tampering is detected", async () => {
  const key = await generateEncryptionKey();
  const plain = randomBytes(FIRST + 4 * CS + 5);
  const { parts } = await encryptToParts(plain, key);
  const blob = join(parts);

  const flipped = blob.slice();
  flipped[HEADER_BYTES + FIRST + 20] ^= 1; // a byte inside chunk 1
  await assertRejects(() => decryptAll(flipped, key), "flipped ciphertext byte");

  const truncatedAtBoundary = join(parts.slice(0, -1)); // drop the last chunk entirely
  await assertRejects(() => decryptAll(truncatedAtBoundary, key), "truncated at a chunk boundary");

  await assertRejects(() => decryptAll(blob.slice(0, blob.byteLength - 3), key), "truncated mid-chunk");

  const reordered = join([parts[0], parts[2], parts[1], ...parts.slice(3)]);
  await assertRejects(() => decryptAll(reordered, key), "chunks reordered");

  const other = (await encryptToParts(randomBytes(plain.byteLength), key)).parts;
  const swapped = join([parts[0], other[1], ...parts.slice(2)]);
  await assertRejects(() => decryptAll(swapped, key), "chunk from another file");

  const headerEdited = blob.slice();
  headerEdited[15] ^= 1; // nonce prefix
  await assertRejects(() => decryptAll(headerEdited, key), "header edited");

  const wrongKey = await generateEncryptionKey();
  await assertRejects(() => decryptAll(blob, wrongKey), "wrong key");

  const extra = join([blob, randomBytes(CS + 16)]);
  await assertRejects(() => decryptAll(extra, key), "extra chunk appended");
});

test("chunked: format detection tells new files from single-shot (v1) encrypted files", async () => {
  const key = await generateEncryptionKey();
  const v2 = join((await encryptToParts(randomBytes(10), key)).parts);
  const v1 = new Uint8Array(await (await encryptFile(new Blob([randomBytes(10)]), key)).data.arrayBuffer());
  assert.equal(isChunkedFormat(v2), true);
  assert.equal(isChunkedFormat(v1), false);
});
