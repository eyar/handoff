const webCrypto = typeof window !== "undefined" && window.crypto ? window.crypto : globalThis.crypto;

/**
 * Converts a Uint8Array into a URL-safe Base64 string.
 */
export function bytesToBase64(bytes) {
  let bin = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return (typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bytes).toString("base64"))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Converts a URL-safe Base64 string into a Uint8Array.
 */
export function base64ToBytes(b64) {
  let str = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) {
    str += "=";
  }
  if (typeof atob !== "undefined") {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(str, "base64"));
}

/**
 * Generates an ephemeral 256-bit AES-GCM encryption key.
 */
export async function generateEncryptionKey() {
  return await webCrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Exports a CryptoKey to a URL-safe Base64 string for the QR hash fragment.
 */
export async function exportKeyToBase64(cryptoKey) {
  if (!cryptoKey) return null;
  const raw = await webCrypto.subtle.exportKey("raw", cryptoKey);
  return bytesToBase64(new Uint8Array(raw));
}

/**
 * Imports a CryptoKey from a URL-safe Base64 string.
 */
export async function importKeyFromBase64(base64Str) {
  if (!base64Str || typeof base64Str !== "string") return null;
  const rawBytes = base64ToBytes(base64Str);
  if (rawBytes.byteLength !== 32) {
    throw new Error(`Invalid key length: expected 32 bytes, got ${rawBytes.byteLength}`);
  }
  return await webCrypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts a plaintext string using AES-256-GCM with a random 12-byte IV.
 */
export async function encryptText(plainText, cryptoKey) {
  if (!cryptoKey || typeof plainText !== "string") {
    return { text: plainText, isEncrypted: false };
  }
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const encodedText = new TextEncoder().encode(plainText);
  const ciphertextBuffer = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encodedText
  );
  return {
    isEncrypted: true,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer))
  };
}

/**
 * Decrypts an encrypted text payload using AES-256-GCM.
 * Handles both encrypted objects and legacy/unencrypted plaintext strings.
 */
export async function decryptText(payload, cryptoKey) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (!payload.isEncrypted) {
    return typeof payload.text === "string" ? payload.text : "";
  }
  if (!cryptoKey) {
    return "[Encrypted message — encryption key missing]";
  }
  try {
    const iv = base64ToBytes(payload.iv);
    const ciphertext = base64ToBytes(payload.ciphertext);
    const decryptedBuffer = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      ciphertext
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    console.error("Text decryption failed:", err);
    return "[Decryption failed — invalid key or corrupt data]";
  }
}

/**
 * Encrypts a File or Blob under 100 MB using AES-256-GCM.
 * Prepends the 12-byte IV directly to the ciphertext in the returned Blob:
 * [ 12 bytes IV ][ AES-GCM Ciphertext + 16-byte Tag ]
 */
export async function encryptFile(fileOrBlob, cryptoKey) {
  if (!cryptoKey || !fileOrBlob) {
    return { data: fileOrBlob, isEncrypted: false };
  }
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    arrayBuffer
  );

  const combinedBytes = new Uint8Array(12 + ciphertext.byteLength);
  combinedBytes.set(iv, 0);
  combinedBytes.set(new Uint8Array(ciphertext), 12);

  const encryptedBlob = new Blob([combinedBytes], { type: "application/octet-stream" });
  return { data: encryptedBlob, isEncrypted: true };
}

/**
 * Decrypts an encrypted file Blob containing [ 12-byte IV ][ Ciphertext ].
 */
export async function decryptFile(encryptedBlob, cryptoKey, mimeType = "application/octet-stream") {
  if (!cryptoKey || !encryptedBlob) {
    return encryptedBlob;
  }
  const arrayBuffer = await encryptedBlob.arrayBuffer();
  if (arrayBuffer.byteLength < 28) {
    throw new Error("Ciphertext too short to contain valid IV and tag");
  }

  const iv = new Uint8Array(arrayBuffer, 0, 12);
  const ciphertext = new Uint8Array(arrayBuffer, 12);

  const decryptedBuffer = await webCrypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );

  return new Blob([decryptedBuffer], { type: mimeType || "application/octet-stream" });
}
