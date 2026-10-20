// Decrypts large chunked-encrypted downloads into the browser's private on-device storage (OPFS) instead of
// memory. The result is a disk-backed File that downloads and shares like any other, which is what lets
// iPhones receive encrypted files of 1 GB+ (Safari reloads the page when it holds ~500 MB in memory).
import { decryptChunkedStream } from "./chunkedCrypto.js";

const DIR_NAME = "handoff-decrypted";
// Rooms expire after 10 minutes, so anything older than this is left over from an earlier visit
const STALE_AFTER_MS = 60 * 60 * 1000;
// Kept long enough to finish saving or sharing, then removed
const DELETE_AFTER_MS = 30 * 60 * 1000;

export function canDecryptToDisk() {
  return typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof globalThis.FileSystemFileHandle?.prototype?.createWritable === "function";
}

async function getDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

function entryName(fileId) {
  return `${String(fileId).replace(/[^\w.-]/g, "_")}-${Date.now().toString(36)}`;
}

// File names can't contain path separators; everything else (spaces, accents) is kept
function safeFileName(name) {
  const cleaned = String(name || "file").replace(/[\\/:\u0000-\u001f]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

async function removeEntry(name) {
  try {
    await (await getDir()).removeEntry(name, { recursive: true });
  } catch {}
}

/**
 * Decrypts `stream` into a new OPFS file and returns it as a File with the original name.
 * Throws (after removing the partial file) if decryption or writing fails, e.g. not enough free space.
 */
export async function decryptStreamToDisk(stream, cryptoKey, fileObj, onProgress) {
  // Each file gets its own folder so the decrypted copy can keep its original name without clashes
  const name = entryName(fileObj.id);
  const folder = await (await getDir()).getDirectoryHandle(name, { create: true });
  const handle = await folder.getFileHandle(safeFileName(fileObj.originalName), { create: true });
  const writable = await handle.createWritable();
  try {
    let written = 0;
    for await (const chunk of decryptChunkedStream(stream, cryptoKey)) {
      await writable.write(chunk);
      written += chunk.byteLength;
      onProgress?.(written, fileObj.size);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await removeEntry(name);
    throw err;
  }
  setTimeout(() => removeEntry(name), DELETE_AFTER_MS);
  // Returned as-is (not re-wrapped) so it stays backed by the disk copy rather than memory
  return handle.getFile();
}

/** Removes decrypted copies left behind by earlier visits. */
export async function sweepStaleDecryptedFiles() {
  if (!canDecryptToDisk()) return;
  try {
    const dir = await getDir();
    const stale = [];
    for await (const [name] of dir.entries()) {
      // Folder names end in their creation time (base 36)
      const createdAt = parseInt(name.split("-").pop(), 36);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > STALE_AFTER_MS) stale.push(name);
    }
    for (const name of stale) await dir.removeEntry(name, { recursive: true }).catch(() => {});
  } catch {}
}
