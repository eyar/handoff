// Chunked end-to-end encryption for files of any size (AES-256-GCM, constant memory).
//
// Encrypted object layout ("HOE2" format, version 1):
//   [ header (20 B) ][ chunk 0 ciphertext ][ chunk 1 ciphertext ] ... [ chunk n-1 ciphertext ]
//   header  = "HOE2" | version (1 B) | reserved (3 B) | chunkSize (uint32 BE) | noncePrefix (8 random B)
//   chunk 0 = (chunkSize - 20) plaintext bytes, chunk j >= 1 = chunkSize plaintext bytes (last may be shorter)
//   each chunk ciphertext = plaintext + 16-byte GCM tag
// So header + chunk 0 and every later chunk are exactly chunkSize + 16 bytes: one chunk = one multipart part,
// and all parts except the last have the same size (an R2/S3 requirement).
//
// Per chunk j:  IV  = noncePrefix || uint32 BE j                     (unique per file and chunk)
//               AAD = header || uint32 BE j || final flag (1 B)      (binds format, position and end of file)
// Reordering, swapping chunks between files, editing the header or truncating at a chunk boundary all fail
// authentication.

const webCrypto = globalThis.crypto;

export const CHUNK_SIZE = 8 * 1024 * 1024; // plaintext bytes per chunk
const TAG_BYTES = 16;
export const PART_SIZE = CHUNK_SIZE + TAG_BYTES; // bytes per multipart part (all but the last)
export const HEADER_BYTES = 20;
const MAGIC = [0x48, 0x4f, 0x45, 0x32]; // "HOE2"
const FORMAT_VERSION = 1;

function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function chunkIv(noncePrefix, index) {
  return concatBytes(noncePrefix, u32be(index));
}

function chunkAad(header, index, isFinal) {
  return concatBytes(header, u32be(index), new Uint8Array([isFinal ? 1 : 0]));
}

function buildHeader(chunkSize, noncePrefix) {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[4] = FORMAT_VERSION;
  new DataView(header.buffer).setUint32(8, chunkSize, false);
  header.set(noncePrefix, 12);
  return header;
}

function parseHeader(header) {
  if (!isChunkedFormat(header) || header.byteLength < HEADER_BYTES) throw new Error("Not a chunked-encrypted file");
  if (header[4] !== FORMAT_VERSION) throw new Error(`Unsupported encryption format version ${header[4]}`);
  const chunkSize = new DataView(header.buffer, header.byteOffset, HEADER_BYTES).getUint32(8, false);
  if (chunkSize <= HEADER_BYTES || chunkSize > 64 * 1024 * 1024) throw new Error("Invalid chunk size");
  return { chunkSize, noncePrefix: header.slice(12, 20) };
}

/** True if the bytes start with the chunked-format magic ("HOE2"). */
export function isChunkedFormat(bytes) {
  return bytes && bytes.byteLength >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

/** Plaintext byte range of each chunk for a file of `plainSize` bytes. */
export function chunkRanges(plainSize, chunkSize = CHUNK_SIZE) {
  const first = chunkSize - HEADER_BYTES;
  const ranges = [[0, Math.min(first, plainSize)]];
  for (let start = first; start < plainSize; start += chunkSize) {
    ranges.push([start, Math.min(start + chunkSize, plainSize)]);
  }
  return ranges;
}

/** Size of the encrypted object for a file of `plainSize` bytes. */
export function encryptedSize(plainSize, chunkSize = CHUNK_SIZE) {
  return HEADER_BYTES + plainSize + TAG_BYTES * chunkRanges(plainSize, chunkSize).length;
}

/**
 * Prepares chunked encryption of a File/Blob. encryptPart(j) returns the bytes of multipart part j
 * (part 0 includes the header). Each call reads and encrypts only its own chunk, and is deterministic,
 * so a failed part can simply be re-encrypted and re-sent.
 */
export function createChunkedEncryptor(file, cryptoKey, chunkSize = CHUNK_SIZE) {
  const noncePrefix = webCrypto.getRandomValues(new Uint8Array(8));
  const header = buildHeader(chunkSize, noncePrefix);
  const ranges = chunkRanges(file.size, chunkSize);
  const count = ranges.length;

  async function encryptPart(index) {
    if (index < 0 || index >= count) throw new RangeError(`No chunk ${index}`);
    const [start, end] = ranges[index];
    const plaintext = await file.slice(start, end).arrayBuffer();
    const ciphertext = new Uint8Array(
      await webCrypto.subtle.encrypt(
        { name: "AES-GCM", iv: chunkIv(noncePrefix, index), additionalData: chunkAad(header, index, index === count - 1) },
        cryptoKey,
        plaintext
      )
    );
    return index === 0 ? concatBytes(header, ciphertext) : ciphertext;
  }

  return { count, encryptedSize: encryptedSize(file.size, chunkSize), encryptPart };
}

/**
 * Decrypts a chunked-encrypted byte stream, yielding plaintext chunks in order.
 * Holds at most about two chunks in memory. The last chunk is recognised by the end of the stream,
 * so no length metadata is needed (and a truncated stream fails authentication).
 */
export async function* decryptChunkedStream(readable, cryptoKey) {
  const reader = readable.getReader();
  const pieces = []; // network reads not yet consumed, joined only when a whole chunk is available
  let buffered = 0;
  let done = false;

  async function fill(minBytes) {
    while (!done && buffered < minBytes) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        done = true;
      } else if (value?.byteLength) {
        pieces.push(value);
        buffered += value.byteLength;
      }
    }
  }

  function take(n) {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = pieces[0];
      const used = Math.min(head.byteLength, n - offset);
      out.set(head.subarray(0, used), offset);
      offset += used;
      if (used === head.byteLength) pieces.shift();
      else pieces[0] = head.subarray(used);
    }
    buffered -= n;
    return out;
  }

  try {
    await fill(HEADER_BYTES);
    if (buffered < HEADER_BYTES) throw new Error("Encrypted file is truncated");
    const header = take(HEADER_BYTES);
    const { chunkSize, noncePrefix } = parseHeader(header);

    for (let index = 0; ; index++) {
      const fullLength = (index === 0 ? chunkSize - HEADER_BYTES : chunkSize) + TAG_BYTES;
      await fill(fullLength + 1); // one extra byte tells us whether another chunk follows
      const isFinal = done && buffered <= fullLength;
      const length = isFinal ? buffered : fullLength;
      if (length < TAG_BYTES) throw new Error("Encrypted file is truncated");

      const plaintext = await webCrypto.subtle.decrypt(
        { name: "AES-GCM", iv: chunkIv(noncePrefix, index), additionalData: chunkAad(header, index, isFinal) },
        cryptoKey,
        take(length)
      );
      yield new Uint8Array(plaintext);
      if (isFinal) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Decrypts a chunked-encrypted stream into a Blob (for previews, sharing and smaller downloads). */
export async function decryptChunkedToBlob(readable, cryptoKey, mimeType = "application/octet-stream") {
  const parts = [];
  for await (const chunk of decryptChunkedStream(readable, cryptoKey)) parts.push(chunk);
  return new Blob(parts, { type: mimeType || "application/octet-stream" });
}
