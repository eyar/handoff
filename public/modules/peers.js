// What the other devices in the room can do, from the metadata each one sends with Supabase presence.
import { state } from "./state.js";
import { canDecryptToDisk } from "./diskDecrypt.js";

// Capabilities this build advertises. Senders only use a feature when every connected peer supports it,
// so a tab still running an older build never receives a format it cannot read.
export const CAPABILITIES = ["e2ee-chunked-1"];

// Added when this browser can decrypt large files into on-device storage instead of memory
function capabilities() {
  return canDecryptToDisk() ? [...CAPABILITIES, "e2ee-disk-decrypt-1"] : CAPABILITIES;
}

export function isIosDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Presence metadata for this device (sent with channel.track). */
export function presenceMeta(role) {
  return { role, deviceId: state.deviceId, joinedAt: Date.now(), caps: capabilities(), ios: isIosDevice() };
}

/** Presence metadata of every other device currently in the room. */
export function otherPeers() {
  const presence = state.channel?.presenceState?.() || {};
  return Object.values(presence)
    .flat()
    .filter((meta) => meta && meta.deviceId !== state.deviceId);
}

export function allPeersSupport(capability) {
  return otherPeers().every((meta) => Array.isArray(meta.caps) && meta.caps.includes(capability));
}

/** True when a connected iPhone/iPad doesn't advertise `capability` (memory there is the tight constraint). */
export function anyIosPeerLacks(capability) {
  return otherPeers().some((meta) => meta.ios === true && !(Array.isArray(meta.caps) && meta.caps.includes(capability)));
}
