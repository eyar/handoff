import test from "node:test";
import assert from "node:assert/strict";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  encryptText,
  decryptText,
  encryptFile,
  decryptFile
} from "../public/modules/crypto.js";

test("crypto: generates 256-bit AES-GCM key and exports/imports to URL-safe base64", async () => {
  const key = await generateEncryptionKey();
  assert.ok(key);

  const b64 = await exportKeyToBase64(key);
  assert.strictEqual(typeof b64, "string");
  assert.strictEqual(b64.length, 43); // 32 bytes in base64url is 43 chars (no padding)
  assert.ok(!b64.includes("+"));
  assert.ok(!b64.includes("/"));
  assert.ok(!b64.includes("="));

  const importedKey = await importKeyFromBase64(b64);
  assert.ok(importedKey);
  assert.strictEqual(importedKey.algorithm.name, "AES-GCM");
});

test("crypto: encrypts and decrypts text round-trip", async () => {
  const key = await generateEncryptionKey();
  const originalText = "Confidential transfer text 🔐 with special characters & emojis: 12345!@#$%^&*()";

  const encrypted = await encryptText(originalText, key);
  assert.strictEqual(encrypted.isEncrypted, true);
  assert.strictEqual(typeof encrypted.iv, "string");
  assert.strictEqual(typeof encrypted.ciphertext, "string");
  assert.notStrictEqual(encrypted.ciphertext, originalText);

  const decrypted = await decryptText(encrypted, key);
  assert.strictEqual(decrypted, originalText);
});

test("crypto: decryptText gracefully handles unencrypted string fallback", async () => {
  const plain = "Hello legacy plaintext";
  const result = await decryptText(plain, null);
  assert.strictEqual(result, plain);
});

test("crypto: encrypts and decrypts file blob round-trip", async () => {
  const key = await generateEncryptionKey();
  const fileContent = "This is a private document content for testing file E2EE.".repeat(50);
  const blob = new Blob([fileContent], { type: "text/plain" });

  const { data: encryptedBlob, isEncrypted } = await encryptFile(blob, key);
  assert.strictEqual(isEncrypted, true);
  // Encrypted blob size = original size + 12 (IV) + 16 (GCM auth tag) = original + 28
  assert.strictEqual(encryptedBlob.size, blob.size + 28);

  const decryptedBlob = await decryptFile(encryptedBlob, key, "text/plain");
  assert.strictEqual(decryptedBlob.size, blob.size);
  const decryptedText = await decryptedBlob.text();
  assert.strictEqual(decryptedText, fileContent);
});

test("crypto: decryption fails with wrong key", async () => {
  const keyA = await generateEncryptionKey();
  const keyB = await generateEncryptionKey();
  const originalText = "Secret message";

  const encrypted = await encryptText(originalText, keyA);
  const decryptedWithWrongKey = await decryptText(encrypted, keyB);
  assert.ok(decryptedWithWrongKey.includes("failed"));
});
