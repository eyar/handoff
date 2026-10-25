// End-to-end encryption for file metadata sent over Supabase Realtime.
// File events carry names, types, sizes and download links; with a room key
// their payloads travel sealed, so the relay only sees ciphertext. peer:hello
// and peer:ack stay readable (roles and connection state) except for their
// existingFiles list, which is sealed the same way.

import { state } from "./state.js";
import { encryptText, decryptText } from "./crypto.js";

const isFileEvent = (event) => typeof event === "string" && event.startsWith("file:");

async function sealJson(value) {
  return encryptText(JSON.stringify(value), state.cryptoKey);
}

async function openJson(sealed) {
  if (!state.cryptoKey || !sealed?.isEncrypted) {
    throw new Error("Sealed payload but no room key");
  }
  // decryptText returns a placeholder string on failure, which JSON.parse rejects
  return JSON.parse(await decryptText(sealed, state.cryptoKey));
}

export async function sealPayload(event, payload) {
  if (!state.cryptoKey || !payload || typeof payload !== "object") return payload;
  if (isFileEvent(event)) {
    return { sealed: await sealJson(payload) };
  }
  if (Array.isArray(payload.existingFiles)) {
    const { existingFiles, ...rest } = payload;
    return { ...rest, sealedFiles: await sealJson(existingFiles) };
  }
  return payload;
}

// Unsealed payloads pass through: the iOS Shortcut upload is sent by the
// server, which has no room key.
export async function openPayload(payload) {
  if (payload?.sealed) {
    return openJson(payload.sealed);
  }
  if (payload?.sealedFiles) {
    const { sealedFiles, ...rest } = payload;
    return { ...rest, existingFiles: await openJson(sealedFiles) };
  }
  return payload;
}

/**
 * Seals outgoing broadcasts and opens incoming ones on a Realtime channel, so
 * every send and handler on it works with plain payloads. Incoming messages
 * are opened one at a time so handlers still run in arrival order.
 */
export function sealChannel(channel) {
  const rawSend = channel.send.bind(channel);
  const rawOn = channel.on.bind(channel);
  let inbox = Promise.resolve();
  let outbox = Promise.resolve();

  // Sealing is async, so sends are queued too: a quick unsealed message must
  // not overtake a file event sent just before it.
  channel.send = (message, ...rest) => {
    if (message?.type !== "broadcast") return rawSend(message, ...rest);
    const sealed = outbox.then(() => sealPayload(message.event, message.payload));
    outbox = sealed.catch(() => {});
    return sealed.then(
      (payload) => rawSend({ ...message, payload }, ...rest),
      (err) => {
        console.warn(`Failed to seal ${message.event}:`, err);
        return "error";
      }
    );
  };

  channel.on = (type, filter, callback) => {
    if (type !== "broadcast") return rawOn(type, filter, callback);
    return rawOn(type, filter, (message) => {
      const opened = inbox.then(() => openPayload(message?.payload));
      inbox = opened.catch(() => {});
      opened.then(
        (payload) => callback({ ...message, payload }),
        (err) => console.warn(`Dropped ${message?.event} that could not be opened:`, err)
      );
    });
  };

  return channel;
}
