import { state } from "./state.js";
import { SESSION_TTL_MS } from "./constants.js";

const COMPUTER_SESSION_KEY = "handoff_computer_session";
const PHONE_SESSION_KEY = "handoff_phone_session";

export function saveComputerSession({ roomId, createdAt = Date.now() }) {
  if (!roomId) return;
  const payload = JSON.stringify({
    roomId,
    role: "computer",
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS
  });
  try {
    localStorage.setItem(COMPUTER_SESSION_KEY, payload);
  } catch (err) {
    console.warn("Could not save computer session:", err);
  }
}

export function getSavedComputerSession() {
  try {
    const raw = localStorage.getItem(COMPUTER_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.roomId || typeof session.createdAt !== "number") {
      clearSavedComputerSession();
      return null;
    }
    const age = Date.now() - session.createdAt;
    if (age >= SESSION_TTL_MS) {
      clearSavedComputerSession(session.roomId);
      return null;
    }
    return session;
  } catch (err) {
    console.warn("Could not parse saved computer session:", err);
    return null;
  }
}

export function clearSavedComputerSession(targetRoomId = null) {
  try {
    const roomId = targetRoomId || state.roomId;
    localStorage.removeItem(COMPUTER_SESSION_KEY);
    if (roomId) {
      localStorage.removeItem(`handoff_files_${roomId}`);
      localStorage.removeItem(`handoff_text_${roomId}`);
      localStorage.removeItem(`handoff_paid_${roomId}`);
      localStorage.removeItem(`handoff_paid_usage_${roomId}`);
      clearSessionCryptoKey(roomId);
    }
  } catch (err) {
    console.warn("Could not clear saved computer session:", err);
  }
}

export function savePhoneSession({
  roomId,
  isFromComputer = false,
  isTargetWindows = false,
  createdAt = Date.now()
}) {
  if (!roomId) return;
  const payload = JSON.stringify({
    roomId,
    role: "phone",
    isFromComputer,
    isTargetWindows,
    createdAt,
    expiresAt: createdAt + SESSION_TTL_MS
  });
  try {
    localStorage.setItem(PHONE_SESSION_KEY, payload);
  } catch (err) {
    console.warn("Could not save phone session:", err);
  }
}

export function getSavedPhoneSession() {
  try {
    const raw = localStorage.getItem(PHONE_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session?.roomId || typeof session.createdAt !== "number") {
      clearSavedPhoneSession();
      return null;
    }
    const age = Date.now() - session.createdAt;
    if (age >= SESSION_TTL_MS) {
      clearSavedPhoneSession(session.roomId);
      return null;
    }
    return session;
  } catch (err) {
    console.warn("Could not parse saved phone session:", err);
    return null;
  }
}

export function clearSavedPhoneSession(targetRoomId = null) {
  try {
    const roomId = targetRoomId || state.roomId;
    localStorage.removeItem(PHONE_SESSION_KEY);
    if (roomId) {
      localStorage.removeItem(`handoff_files_${roomId}`);
      localStorage.removeItem(`handoff_text_${roomId}`);
      localStorage.removeItem(`handoff_paid_${roomId}`);
      localStorage.removeItem(`handoff_paid_usage_${roomId}`);
      clearSessionCryptoKey(roomId);
    }
  } catch (err) {
    console.warn("Could not clear saved phone session:", err);
  }
}

export function saveCachedFiles(roomId, files) {
  if (!roomId) return;
  try {
    const lightFiles = (files || []).map((f) => ({
      id: f.id,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      downloadUrl: f.downloadUrl,
      storagePath: f.storagePath,
      senderDevice: f.senderDevice,
      expiresAt: f.expiresAt,
      isEncrypted: Boolean(f.isEncrypted)
    }));
    localStorage.setItem(`handoff_files_${roomId}`, JSON.stringify(lightFiles));
  } catch (err) {
    console.warn("Could not cache files:", err);
  }
}

export function loadCachedFiles(roomId) {
  if (!roomId) return [];
  try {
    const raw = localStorage.getItem(`handoff_files_${roomId}`);
    if (!raw) return [];
    const files = JSON.parse(raw);
    const now = Date.now();
    return Array.isArray(files) ? files.filter((f) => !f.expiresAt || f.expiresAt > now) : [];
  } catch (err) {
    console.warn("Could not load cached files:", err);
    return [];
  }
}

export function saveCachedText(roomId, text) {
  if (!roomId) return;
  try {
    localStorage.setItem(`handoff_text_${roomId}`, text || "");
  } catch (err) {
    console.warn("Could not cache text:", err);
  }
}

export function loadCachedText(roomId) {
  if (!roomId) return "";
  try {
    return localStorage.getItem(`handoff_text_${roomId}`) || "";
  } catch (err) {
    console.warn("Could not load cached text:", err);
    return "";
  }
}

// Compatibility helpers: all sessions are completely free and unlocked
export function setPaidSession(roomId) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("handoff:paid", { detail: { roomId } }));
  }
}

export function isPaidSession() {
  return true;
}

export function getPaidUsage() {
  return { largeFilesCount: 0, totalLargeBytes: 0 };
}

export function recordPaidUpload() {
  return { largeFilesCount: 0, totalLargeBytes: 0 };
}

export function isFairUseLimitReached() {
  return false;
}

export function saveSessionCryptoKey(roomId, keyBase64) {
  if (!roomId || !keyBase64) return;
  try {
    sessionStorage.setItem(`handoff_key_${roomId}`, keyBase64);
    localStorage.setItem(`handoff_key_${roomId}`, keyBase64);
  } catch (err) {
    console.warn("Could not save session crypto key:", err);
  }
}

export function getSessionCryptoKey(roomId) {
  if (!roomId) return null;
  try {
    return sessionStorage.getItem(`handoff_key_${roomId}`) || localStorage.getItem(`handoff_key_${roomId}`);
  } catch (err) {
    console.warn("Could not retrieve session crypto key:", err);
    return null;
  }
}

export function clearSessionCryptoKey(roomId) {
  if (!roomId) return;
  try {
    sessionStorage.removeItem(`handoff_key_${roomId}`);
    localStorage.removeItem(`handoff_key_${roomId}`);
  } catch (err) {
    console.warn("Could not clear session crypto key:", err);
  }
}
