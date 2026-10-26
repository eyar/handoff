import { qrcode } from "/vendor/qrcode/qrcode.mjs";
import { state, getRole } from "./modules/state.js";
import { initGlobalErrorTracking, copyDiagnostics } from "./modules/diagnostics.js";
import { initKillSwitch } from "./modules/killSwitch.js";
import {
  $,
  setStatus,
  show,
  isDesktopComputer,
  isWindowsPlatform,
  generateSecureToken,
  formatFileRemaining,
  formatBytes
} from "./modules/dom.js";
import {
  setupRealtimeChannel,
  resetComputerPairingUI,
  onComputerConnected,
  endRoom
} from "./modules/realtime.js";
import { initComputerBridge, openPairingScanner } from "./modules/computerBridge.js";
import { setupFileUpload } from "./modules/upload.js";
import {
  renderFiles,
  removeSharedFiles,
  expireFile,
  handleSelectAll,
  initiateBulkDownload
} from "./modules/fileManager.js";
import {
  setupLiveTextInput,
  updateTextExpiryUI
} from "./modules/textSync.js";
import { setupInstantUrlListeners } from "./modules/urlDetector.js";
import {
  handleGlobalPaste,
  handleDesktopFilePaste,
  handleDesktopTextPaste,
  handlePhoneFilePaste,
  handlePhoneTextPaste,
  setupDesktopDropzoneContextMenu,
  handleTextCopy,
  handleTextAction,
  copyMultipleFiles,
  shareMultipleFiles,
  applyDeviceButtonCustomizations
} from "./modules/clipboard.js";
import {
  saveComputerSession,
  getSavedComputerSession,
  savePhoneSession,
  getSavedPhoneSession,
  loadCachedFiles,
  loadCachedText,
  isPaidSession,
  saveSessionCryptoKey,
  getSessionCryptoKey
} from "./modules/session.js";
import {
  generateEncryptionKey,
  exportKeyToBase64,
  importKeyFromBase64,
  encryptText
} from "./modules/crypto.js";
import {
  FILE_TTL_MS
} from "./modules/constants.js";
import { initShareTarget } from "./modules/shareTarget.js";
import { initExtensionBridge, isEmbeddedByExtension, showExtensionLinks } from "./modules/extensionBridge.js";
import { isIosDevice } from "./modules/peers.js";
import { sweepStaleDecryptedFiles } from "./modules/diskDecrypt.js";

// Initialize global uncaught error and promise rejection telemetry
initGlobalErrorTracking();

// Initialize emergency kill switch / maintenance listener
initKillSwitch();

// Accept text/files from the Handoff browser extension when embedded in its side panel
initExtensionBridge();
showExtensionLinks();
// The Shortcut installs on the phone itself, so only iPhones and iPads are offered it there
if (isIosDevice()) $("#phone-ios-shortcut-link")?.classList.remove("hidden");

// Initialize File Upload handlers
state.desktopFileUpload = setupFileUpload({
  dropzoneEl: $("#desktop-dropzone"),
  inputEl: $("#desktop-file-input"),
  previewListEl: $("#desktop-file-preview-list"),
  sendBtn: $("#desktop-file-send"),
  progressContainerEl: $("#desktop-file-progress-container"),
  progressBarEl: $("#desktop-file-progress-bar"),
  progressTextEl: $("#desktop-file-progress-text"),
  cancelBtnEl: $("#desktop-file-cancel"),
  statusEl: $("#desktop-file-status"),
  senderDevice: "Computer",
  targetDeviceName: "phone"
});

state.phoneFileUpload = setupFileUpload({
  dropzoneEl: $("#phone-dropzone"),
  inputEl: $("#phone-file-input"),
  previewListEl: $("#phone-file-preview-list"),
  sendBtn: $("#phone-file-send"),
  progressContainerEl: $("#phone-file-progress-container"),
  progressBarEl: $("#phone-file-progress-bar"),
  progressTextEl: $("#phone-file-progress-text"),
  cancelBtnEl: $("#phone-file-cancel"),
  statusEl: $("#phone-file-status"),
  senderDevice: "Phone",
  targetDeviceName: "computer"
});

// Initialize Live Text Sync handlers
state.desktopTextSync = setupLiveTextInput($("#desktop-text"), $("#desktop-text-status"), "phone");
state.phoneTextSync = setupLiveTextInput($("#phone-text"), $("#phone-result"), "computer");

// Room Creation & Restoration (Desktop)
export async function startComputerSession(existingRoomId = null, sessionCreatedAt = null, existingKeyBase64 = null) {
  if (state.isMaintenanceActive) {
    alert("Handoff is currently undergoing maintenance. Transfers are temporarily paused.");
    return;
  }
  const isResume = Boolean(existingRoomId);
  const roomId = existingRoomId || generateSecureToken(10);
  const createdAt = sessionCreatedAt || Date.now();

  state.roomId = roomId;
  state.currentRole = "computer";
  state.isSessionPaid = isPaidSession(state.roomId);

  let keyBase64 = existingKeyBase64 || getSessionCryptoKey(roomId);
  if (!keyBase64) {
    try {
      const newKey = await generateEncryptionKey();
      state.cryptoKey = newKey;
      state.cryptoKeyBase64 = await exportKeyToBase64(newKey);
      keyBase64 = state.cryptoKeyBase64;
    } catch (err) {
      console.warn("Failed to generate encryption key:", err);
    }
  } else {
    state.cryptoKeyBase64 = keyBase64;
    try {
      state.cryptoKey = await importKeyFromBase64(keyBase64);
    } catch (err) {
      console.warn("Failed to import crypto key:", err);
    }
  }
  if (keyBase64) {
    saveSessionCryptoKey(roomId, keyBase64);
  }

  saveComputerSession({ roomId, createdAt });

  try {
    // Keep computer address bar clean and private (no room token visible to bystanders)
    if (location.search || location.hash) {
      history.replaceState({ role: "computer" }, "", location.pathname);
    }
  } catch (err) {
    console.warn("Could not clean URL:", err);
  }

  // Restore cached files or reset
  const cachedFiles = loadCachedFiles(roomId);
  state.sharedFiles = cachedFiles;
  renderFiles(state.sharedFiles);

  // Restore cached text
  const cachedText = loadCachedText(roomId);
  if (cachedText && $("#desktop-text")) {
    $("#desktop-text").value = cachedText;
    state.desktopTextSync?.onInput();
  }

  resetComputerPairingUI();

  $("#computer-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);

  const isHostPc = isDesktopComputer();
  const isWinHost = isWindowsPlatform();
  const queryParams = [`room=${encodeURIComponent(state.roomId)}`];
  if (isHostPc) queryParams.push("from=pc");
  let pairingOrigin = location.origin;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    pairingOrigin = "https://tunnel.handoffdrop.app";
  }
  const hashPart = state.cryptoKeyBase64 ? `#key=${state.cryptoKeyBase64}` : "";
  const pairingUrl = `${pairingOrigin}${location.pathname}?${queryParams.join("&")}${hashPart}`;
  const qr = qrcode(0, "M");
  qr.addData(pairingUrl);
  qr.make();
  $("#qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 1, scalable: true });

  if (isResume) {
    setStatus($("#peer-status"), "Reconnected. Waiting for your phone…");
  } else {
    setStatus($("#peer-status"), "Waiting for your phone…");
  }

  show("computer");
  setupRealtimeChannel(state.roomId, "computer");
}

// Global handler for bridging Computer 2 to Computer 1's room
window.handleComputerBridgeRedirect = async (targetRoomId, targetKeyBase64 = null) => {
  if (!targetRoomId || targetRoomId === state.roomId) return;
  const keyToUse = targetKeyBase64 || state.cryptoKeyBase64;
  await startComputerSession(targetRoomId, null, keyToUse);
  onComputerConnected();
};

$("#create-room")?.addEventListener("click", () => {
  startComputerSession();
});

// End Room buttons
[$("#end-room"), $("#phone-end")].forEach((button) => {
  button?.addEventListener("click", endRoom);
});

// Clipboard and Paste event handlers
window.addEventListener("paste", handleGlobalPaste);
$("#desktop-paste-file")?.addEventListener("click", (e) => handleDesktopFilePaste(e.currentTarget));
$("#desktop-paste-text")?.addEventListener("click", (e) => handleDesktopTextPaste(e.currentTarget));
$("#phone-paste-file")?.addEventListener("click", (e) => handlePhoneFilePaste(e.currentTarget));
$("#phone-paste-text")?.addEventListener("click", (e) => handlePhoneTextPaste(e.currentTarget));
setupDesktopDropzoneContextMenu();
setupInstantUrlListeners();

// Text Copy and Share actions
$("#copy")?.addEventListener("click", async (e) => {
  await handleTextCopy("#desktop-text", e.currentTarget, "computer");
});

$("#share")?.addEventListener("click", async (e) => {
  await handleTextAction("#desktop-text", e.currentTarget, "computer");
});

$("#phone-copy")?.addEventListener("click", async (e) => {
  await handleTextCopy("#phone-text", e.currentTarget, "phone");
});

$("#phone-share")?.addEventListener("click", async (e) => {
  await handleTextAction("#phone-text", e.currentTarget, "phone");
});

// File Batch Operations
[$("#desktop-download-selected"), $("#phone-download-selected")].forEach((btn) => {
  btn?.addEventListener("click", (e) => {
    const selected = state.sharedFiles.filter((f) => state.selectedFileIds.has(f.id));
    if (selected.length > 0) {
      initiateBulkDownload(selected, e.currentTarget);
    }
  });
});

[$("#desktop-share-selected"), $("#phone-share-selected")].forEach((btn) => {
  btn?.addEventListener("click", (e) => {
    const selected = state.sharedFiles.filter((f) => state.selectedFileIds.has(f.id));
    if (selected.length > 0) {
      if (isDesktopComputer()) {
        copyMultipleFiles(selected, e.currentTarget);
      } else {
        shareMultipleFiles(selected);
      }
    }
  });
});

[$("#desktop-delete-selected"), $("#phone-delete-selected")].forEach((btn) => {
  btn?.addEventListener("click", () => {
    const selected = state.sharedFiles.filter((f) => state.selectedFileIds.has(f.id));
    if (selected.length > 0) {
      removeSharedFiles(selected);
    }
  });
});

[$("#desktop-select-all"), $("#phone-select-all")].forEach((cb) => {
  cb?.addEventListener("change", (e) => {
    handleSelectAll(e.target.checked);
  });
});

// Live ticker for text and individual file countdowns
setInterval(() => {
  const now = Date.now();

  updateTextExpiryUI(now);

  if (state.sharedFiles.length > 0) {
    const expiredIds = [];

    document.querySelectorAll(".file-expiry-badge").forEach((badge) => {
      const fileId = badge.dataset.fileId;
      const file = state.sharedFiles.find((f) => f.id === fileId);
      if (!file || !file.expiresAt) return;

      const remainingSec = Math.max(0, Math.ceil((file.expiresAt - now) / 1000));
      if (remainingSec <= 0) {
        if (!expiredIds.includes(fileId)) {
          expiredIds.push(fileId);
        }
      } else {
        const timeSpan = badge.querySelector(".file-expiry-time");
        if (timeSpan) {
          timeSpan.textContent = formatFileRemaining(file.expiresAt);
        }
        if (remainingSec <= 60) {
          badge.classList.add("expiring-soon");
        } else {
          badge.classList.remove("expiring-soon");
        }
      }
    });

    expiredIds.forEach((id) => expireFile(id));
  }
}, 1000);

const PENDING_STAGED_FILE_KEY = "handoff_pending_staged_file";

/**
 * Room for the staged card's "scan with another device" QR: the phone's current room, or a new one with its
 * own encryption key. The key goes in the QR's #key= fragment so whichever device opens it shares the key.
 */
async function phonePairingRoom() {
  if (state.roomId) {
    return { roomId: state.roomId, keyBase64: state.cryptoKeyBase64 || hashKey || getSessionCryptoKey(state.roomId) };
  }
  const roomId = generateSecureToken(10);
  try {
    return { roomId, keyBase64: await exportKeyToBase64(await generateEncryptionKey()) };
  } catch (err) {
    console.warn("Failed to generate encryption key:", err);
    return { roomId, keyBase64: null };
  }
}

function renderStagedPairingQr({ roomId, keyBase64 }, target = "#staged-phone-qr") {
  let pairingOrigin = location.origin;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    pairingOrigin = "https://tunnel.handoffdrop.app";
  }
  const qr = qrcode(0, "M");
  qr.addData(`${pairingOrigin}/?room=${roomId}${keyBase64 ? `#key=${keyBase64}` : ""}`);
  qr.make();
  const qrEl = $(target);
  if (qrEl) {
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  }
}

// Grace period before offering to pair, so a computer that briefly drops off (tab switch, reconnect) doesn't flash the card
const PAIR_CARD_DELAY_MS = 2500;
let pairCardTimer = null;

/** Shows the phone's pair card while no computer is in the room. The staged card already offers the same. */
state.onPhonePresence = (hasComputer) => {
  clearTimeout(pairCardTimer);
  const cardEl = $("#phone-pair-card");
  if (hasComputer) {
    cardEl?.classList.add("hidden");
    const kickerEl = $("#phone-kicker");
    if (kickerEl) kickerEl.textContent = "You’re connected";
    return;
  }
  pairCardTimer = setTimeout(() => {
    if (state.currentRole !== "phone" || !state.roomId) return;
    if (!$("#phone-staged-connect-card")?.classList.contains("hidden")) return;
    renderStagedPairingQr({ roomId: state.roomId, keyBase64: state.cryptoKeyBase64 }, "#phone-pair-qr");
    cardEl?.classList.remove("hidden");
    const phoneTitle = $("#phone-title");
    if (phoneTitle) phoneTitle.textContent = "Send it to your computer.";
    const kickerEl = $("#phone-kicker");
    if (kickerEl) kickerEl.textContent = "Not paired";
    const phoneTimer = $("#phone-timer");
    if (phoneTimer) {
      phoneTimer.textContent = "Waiting";
      phoneTimer.className = "pill";
    }
  }, PAIR_CARD_DELAY_MS);
};

$("#phone-pair-scan-btn")?.addEventListener("click", () => {
  openPairingScanner({
    title: "Scan Computer Screen",
    statusText: "Point camera at the QR code on your PC screen…",
    triggerBtn: "#phone-pair-scan-btn",
    onScan: (scannedRoomId, scannedKey) => {
      if (scannedRoomId === state.roomId) return;
      $("#phone-pair-card")?.classList.add("hidden");
      connectPhoneSession({ roomId: scannedRoomId, keyBase64: scannedKey });
    }
  });
});

const PENDING_SHARED_TEXT_KEY = "handoff_pending_shared_text";
let pendingTextDelivery = 0;

function hasComputerPeer() {
  const allPeers = Object.values(state.channel?.presenceState() || {}).flat();
  return allPeers.some((p) => p.role === "computer" && p.deviceId !== state.deviceId);
}

/**
 * Text shared from the iOS Shortcut before pairing waits here, outside the text box, so its 60-second
 * expiry only starts once a computer has joined. Calling again (e.g. after scanning another QR) restarts the wait.
 */
async function deliverPendingSharedText() {
  let text = "";
  try {
    text = sessionStorage.getItem(PENDING_SHARED_TEXT_KEY) || "";
  } catch (_) {}
  if (!text) return;
  const run = ++pendingTextDelivery;
  while (run === pendingTextDelivery) {
    if (state.channel?.state === "joined" && hasComputerPeer()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (run !== pendingTextDelivery) return;

  try {
    sessionStorage.removeItem(PENDING_SHARED_TEXT_KEY);
  } catch (_) {}
  $("#phone")?.classList.remove("shortcut-item-pending");
  const textEl = $("#phone-text");
  if (textEl) {
    textEl.value = text;
    textEl.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      state.phoneTextSync?.syncNow?.();
    } catch (err) {
      console.warn("Failed to sync shared text:", err);
    }
  }
  const badgeEl = $("#staged-card-badge");
  if (badgeEl) {
    badgeEl.textContent = "✓ Sent";
    badgeEl.className = "staged-card-badge delivered";
  }
  const promptEl = $("#staged-card-prompt");
  if (promptEl) promptEl.textContent = "✓ Sent to your computer!";
  setTimeout(() => {
    $("#staged-connect-details")?.classList.add("hidden");
  }, 1500);
}

export async function broadcastPendingStagedFile(fileObj) {
  if (!state.roomId || !fileObj) return;

  if (fileObj.storagePath) {
    state.roomUploadedFiles.add(fileObj.storagePath);
  }

  // Ensure file is in state.sharedFiles
  if (!state.sharedFiles.some((f) => f.id === fileObj.id)) {
    state.sharedFiles.unshift(fileObj);
    renderFiles(state.sharedFiles);
  }

  const badgeEl = $("#staged-card-badge");
  const promptEl = $("#staged-card-prompt");

  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (state.channel && state.channel.state === "joined") {
      try {
        const res = await state.channel.send({
          type: "broadcast",
          event: "file:ready",
          payload: {
            fileId: fileObj.id,
            originalName: fileObj.originalName,
            mimeType: fileObj.mimeType,
            size: fileObj.size,
            downloadUrl: fileObj.downloadUrl,
            storagePath: fileObj.storagePath,
            senderDevice: state.currentRole === "phone" ? "iPhone" : "Computer",
            expiresAt: fileObj.expiresAt,
            isEncrypted: Boolean(fileObj.isEncrypted)
          }
        });

        if (res === "ok") {
          // Also broadcast peer:hello with existingFiles for guaranteed receipt
          const phoneCurrentText = $("#phone-text")?.value || "";
          let syncPhoneText = phoneCurrentText;
          if (state.cryptoKey && phoneCurrentText) {
            try {
              syncPhoneText = await encryptText(phoneCurrentText, state.cryptoKey);
            } catch (_) {}
          }
          state.channel.send({
            type: "broadcast",
            event: "peer:hello",
            payload: {
              role: state.currentRole || "phone",
              deviceId: state.deviceId,
              existingFiles: state.sharedFiles
                .filter((f) => !f.expiresAt || f.expiresAt > Date.now())
                .map((f) => ({
                  fileId: f.id,
                  originalName: f.originalName,
                  mimeType: f.mimeType,
                  size: f.size,
                  downloadUrl: f.downloadUrl,
                  storagePath: f.storagePath,
                  senderDevice: f.senderDevice,
                  expiresAt: f.expiresAt,
                  isEncrypted: Boolean(f.isEncrypted)
                })),
              currentText: syncPhoneText,
              textExpiresAt: state.sharedTextExpiresAt
            }
          });

          // Only declare delivered and hide pairing UI if a computer peer is actually in the room!
          const presState = state.channel?.presenceState() || {};
          const allPeers = Object.values(presState).flat();
          const hasComputer = allPeers.some((p) => p.role === "computer" && p.deviceId !== state.deviceId);

          if (hasComputer) {
            if (badgeEl) {
              badgeEl.textContent = "✓ Sent";
              badgeEl.className = "staged-card-badge delivered";
            }
            if (promptEl) {
              promptEl.textContent = `✓ Sent "${fileObj.originalName}" to your computer!`;
            }
            const statusEl = $("#phone-peer-status") || $("#phone-result") || $("#peer-status");
            if (statusEl) {
              setStatus(statusEl, `✓ Sent "${fileObj.originalName}" to your computer!`);
            }

            try {
              sessionStorage.removeItem(PENDING_STAGED_FILE_KEY);
            } catch (_) {}
            $("#phone")?.classList.remove("shortcut-item-pending");

            setTimeout(() => {
              $("#staged-connect-details")?.classList.add("hidden");
            }, 1500);

            break;
          } else {
            // No computer peer active yet! Keep connect details and scan button available.
            $("#staged-connect-details")?.classList.remove("hidden");
          }
        } else {
          console.warn("Realtime send status:", res, "- retrying in 300ms...");
        }
      } catch (err) {
        console.warn("Retrying staged file broadcast:", err);
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Phone Session Connection
export async function connectPhoneSession({
  roomId,
  isFromComputer = false,
  isTargetWindows = false,
  createdAt = Date.now(),
  keyBase64 = null
}) {
  state.roomId = roomId;
  state.currentRole = "phone";
  state.isSessionPaid = isPaidSession(state.roomId);
  state.qrFromComputer = isFromComputer;
  state.isTargetWindows = isTargetWindows;

  const cryptoKeyStr = keyBase64 || getSessionCryptoKey(roomId);
  if (cryptoKeyStr) {
    try {
      state.cryptoKey = await importKeyFromBase64(cryptoKeyStr);
      state.cryptoKeyBase64 = cryptoKeyStr;
      saveSessionCryptoKey(roomId, cryptoKeyStr);
    } catch (err) {
      console.warn("Could not import phone crypto key:", err);
    }
  }

  savePhoneSession({ roomId, isFromComputer, isTargetWindows, createdAt });

  const bridgePromptCard = $("#bridge-prompt-card");
  if (bridgePromptCard) {
    if (isFromComputer) {
      bridgePromptCard.classList.remove("hidden");
    } else {
      bridgePromptCard.classList.add("hidden");
    }
  }
  const phoneTimer = $("#phone-timer");
  if (phoneTimer) {
    phoneTimer.textContent = "Connecting…";
    phoneTimer.className = "pill";
  }

  $("#phone-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);

  show("phone");
  setStatus($("#phone-peer-status") || $("#phone-result"), "Connecting to computer…");
  setupRealtimeChannel(state.roomId, "phone");

  // Check if a staged file is pending delivery
  try {
    const rawPending = sessionStorage.getItem(PENDING_STAGED_FILE_KEY);
    if (rawPending) {
      const pendingFile = JSON.parse(rawPending);
      if (pendingFile?.id) {
        broadcastPendingStagedFile(pendingFile);
      }
    }
  } catch (_) {}
  deliverPendingSharedText();
}

// Auto-join or restore room on initial page load
const urlParams = new URLSearchParams(location.search);
const requestedRoom = urlParams.get("room");
const isFromComputer = urlParams.get("from") === "pc" || urlParams.get("from") === "computer";
const isTargetWindows = urlParams.get("target") === "win" || urlParams.get("win") === "1";
const savedComputerSession = getSavedComputerSession();
const savedPhoneSession = getSavedPhoneSession();

// Parse hash parameters (#key=... or #k=...)
const hashStr = location.hash.startsWith("#") ? location.hash.slice(1) : "";
const hashParams = new URLSearchParams(hashStr);
const hashKey = hashParams.get("key") || hashParams.get("k");

const isDesktop = isDesktopComputer();

// If this browser is a desktop computer:
if (isDesktop) {
  const targetRoom = requestedRoom || savedComputerSession?.roomId;
  if (targetRoom) {
    startComputerSession(targetRoom, savedComputerSession?.createdAt, hashKey);
  } else if (isEmbeddedByExtension()) {
    startComputerSession();
  }
} else if (requestedRoom) {
  // Mobile or guest device scanning the QR code
  connectPhoneSession({ roomId: requestedRoom, isFromComputer, isTargetWindows, keyBase64: hashKey });
  if (hashKey) {
    try {
      history.replaceState({ role: "phone" }, "", location.pathname + location.search);
    } catch (_) {}
  }
} else if (savedPhoneSession) {
  // Restore phone session on PWA reload or share target landing
  connectPhoneSession({
    roomId: savedPhoneSession.roomId,
    isFromComputer: savedPhoneSession.isFromComputer,
    isTargetWindows: savedPhoneSession.isTargetWindows,
    createdAt: savedPhoneSession.createdAt,
    keyBase64: hashKey
  });
}

// Ingest staged file uploaded by iOS Shortcut
const stagedFileId = urlParams.get("staged");
let pendingFileObj = null;

if (stagedFileId) {
  const stagedName = urlParams.get("name") || "Shared File";
  const stagedSize = Number(urlParams.get("size")) || 0;
  const stagedType = urlParams.get("type") || "application/octet-stream";
  const stagedUrl = urlParams.get("fileUrl") || urlParams.get("url") || "";
  const stagedPath = urlParams.get("path") || "";

  pendingFileObj = {
    id: stagedFileId,
    originalName: stagedName,
    mimeType: stagedType,
    size: stagedSize,
    downloadUrl: stagedUrl,
    storagePath: stagedPath,
    expiresAt: Date.now() + FILE_TTL_MS,
    senderDevice: "iPhone"
  };

  // Persist pending file so camera scanning or reloads preserve it
  try {
    sessionStorage.setItem(PENDING_STAGED_FILE_KEY, JSON.stringify(pendingFileObj));
  } catch (_) {}

  // Clean URL query parameters so reloading doesn't duplicate
  try {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete("staged");
    cleanUrl.searchParams.delete("name");
    cleanUrl.searchParams.delete("size");
    cleanUrl.searchParams.delete("type");
    cleanUrl.searchParams.delete("url");
    cleanUrl.searchParams.delete("fileUrl");
    cleanUrl.searchParams.delete("path");
    cleanUrl.searchParams.delete("held");
    const newQuery = cleanUrl.searchParams.toString();
    history.replaceState(null, "", cleanUrl.pathname + (newQuery ? `?${newQuery}` : ""));
  } catch (_) {}
} else if (!isDesktop) {
  try {
    const rawPending = sessionStorage.getItem(PENDING_STAGED_FILE_KEY);
    if (rawPending) {
      pendingFileObj = JSON.parse(rawPending);
    }
  } catch (_) {}
}

if (pendingFileObj) {
  const fileObj = pendingFileObj;

  if (fileObj.storagePath) {
    state.roomUploadedFiles.add(fileObj.storagePath);
  }

  // Add to shared files list immediately so it displays right away
  if (!state.sharedFiles.some((f) => f.id === fileObj.id)) {
    state.sharedFiles.unshift(fileObj);
    renderFiles(state.sharedFiles);
  }

  // Always show the Phone view when a staged file lands
  show("phone");
  $("#phone")?.classList.add("shortcut-item-pending");
  const cardEl = $("#phone-staged-connect-card");
  if (cardEl) {
    cardEl.classList.remove("hidden");
    const nameEl = $("#staged-card-filename");
    if (nameEl) nameEl.textContent = fileObj.originalName;
    const sizeEl = $("#staged-card-filesize");
    if (sizeEl) sizeEl.textContent = formatBytes(fileObj.size);
  }

  // Setup the camera QR code scanner button
  const scanBtn = $("#staged-scan-camera-btn");
  scanBtn?.addEventListener("click", () => {
    openPairingScanner({
      title: "Scan Computer Screen",
      statusText: "Point camera at the QR code on your PC screen…",
      triggerBtn: "#staged-scan-camera-btn",
      onScan: (scannedRoomId, scannedKey) => {
        const badgeEl = $("#staged-card-badge");
        if (badgeEl) {
          badgeEl.textContent = "Sending…";
          badgeEl.className = "staged-card-badge sending";
        }
        const promptEl = $("#staged-card-prompt");
        if (promptEl) {
          promptEl.textContent = "Connecting to your computer…";
        }
        connectPhoneSession({ roomId: scannedRoomId, keyBase64: scannedKey });
        broadcastPendingStagedFile(fileObj);
      }
    });
  });

  // Always make sure connect details with scan button are visible initially
  $("#staged-connect-details")?.classList.remove("hidden");

  // Setup the phone pairing QR
  const hadRoom = Boolean(state.roomId);
  phonePairingRoom().then((pairing) => {
    renderStagedPairingQr(pairing);
    if (!hadRoom) connectPhoneSession(pairing);
  });

  if (hadRoom) {
    const badgeEl = $("#staged-card-badge");
    const promptEl = $("#staged-card-prompt");

    // Check if an active computer peer is in this room right now
    const presState = state.channel?.presenceState() || {};
    const allPeers = Object.values(presState).flat();
    const hasComputer = allPeers.some((p) => p.role === "computer" && p.deviceId !== state.deviceId);

    if (hasComputer) {
      if (badgeEl) {
        badgeEl.textContent = "Sending…";
        badgeEl.className = "staged-card-badge sending";
      }
      if (promptEl) {
        promptEl.textContent = `Sending to paired computer…`;
      }
    } else {
      if (badgeEl) {
        badgeEl.textContent = "Ready to send";
        badgeEl.className = "staged-card-badge";
      }
      if (promptEl) {
        promptEl.innerHTML = `<strong>Pair with your computer:</strong> Scan the QR code on your computer screen to send this file instantly.`;
      }
    }

    broadcastPendingStagedFile(fileObj);
  }
}

// Ingest text/url passed via query parameters (e.g. from iOS Shortcut or external deep links)
// Never treat a staged file transfer as text sync!
let sharedQueryText = (!stagedFileId && !pendingFileObj) ? (urlParams.get("text") || urlParams.get("url")) : null;

// Phone with no session yet: hold the text and offer pairing, like a staged file
if (sharedQueryText && !isDesktop && !state.roomId) {
  const pendingText = sharedQueryText;
  sharedQueryText = null;
  try {
    sessionStorage.setItem(PENDING_SHARED_TEXT_KEY, pendingText);
  } catch (_) {}
  try {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete("text");
    cleanUrl.searchParams.delete("url");
    const newQuery = cleanUrl.searchParams.toString();
    history.replaceState(null, "", cleanUrl.pathname + (newQuery ? `?${newQuery}` : ""));
  } catch (_) {}

  const isLink = /^https?:\/\/\S+$/i.test(pendingText.trim());
  show("phone");
  $("#phone")?.classList.add("shortcut-item-pending");
  $("#phone-staged-connect-card")?.classList.remove("hidden");
  const nameEl = $("#staged-card-filename");
  if (nameEl) nameEl.textContent = pendingText.length > 120 ? `${pendingText.slice(0, 120)}…` : pendingText;
  const sizeEl = $("#staged-card-filesize");
  if (sizeEl) sizeEl.textContent = isLink ? "Link" : "Text";
  const promptEl = $("#staged-card-prompt");
  if (promptEl) {
    promptEl.innerHTML = `<strong>Pair with your computer:</strong> Scan the QR code on your computer screen to send this ${isLink ? "link" : "text"} instantly.`;
  }

  $("#staged-scan-camera-btn")?.addEventListener("click", () => {
    openPairingScanner({
      title: "Scan Computer Screen",
      statusText: "Point camera at the QR code on your PC screen…",
      triggerBtn: "#staged-scan-camera-btn",
      onScan: (scannedRoomId, scannedKey) => {
        const badgeEl = $("#staged-card-badge");
        if (badgeEl) {
          badgeEl.textContent = "Sending…";
          badgeEl.className = "staged-card-badge sending";
        }
        const scanPromptEl = $("#staged-card-prompt");
        if (scanPromptEl) scanPromptEl.textContent = "Connecting to your computer…";
        connectPhoneSession({ roomId: scannedRoomId, keyBase64: scannedKey });
      }
    });
  });
  $("#staged-connect-details")?.classList.remove("hidden");

  // Or open this phone's own room on another device
  phonePairingRoom().then((pairing) => {
    renderStagedPairingQr(pairing);
    connectPhoneSession(pairing);
  });
}

if (sharedQueryText) {
  setTimeout(() => {
    const isPhone = state.currentRole === "phone";
    const textEl = isPhone ? $("#phone-text") : $("#desktop-text");
    const statusEl = isPhone ? $("#phone-result") : $("#desktop-text-status");
    const syncObj = isPhone ? state.phoneTextSync : state.desktopTextSync;
    if (textEl) {
      textEl.value = sharedQueryText;
      textEl.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        if (typeof syncObj?.syncNow === "function") {
          syncObj.syncNow();
        } else if (typeof syncObj?.onInput === "function") {
          syncObj.onInput();
        }
      } catch (err) {
        console.warn("Failed to sync query text:", err);
      }
      setStatus(statusEl, "✓ Shared text received");
    }
    try {
      const cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete("text");
      cleanUrl.searchParams.delete("url");
      const newQuery = cleanUrl.searchParams.toString();
      history.replaceState(null, "", cleanUrl.pathname + (newQuery ? `?${newQuery}` : ""));
    } catch (_) {}
  }, 300);
}

if (typeof window !== "undefined") {
  initComputerBridge();
  initShareTarget(startComputerSession);
  sweepStaleDecryptedFiles();
  window.addEventListener("DOMContentLoaded", () => {
    applyDeviceButtonCustomizations();
    initComputerBridge();

    const copyDiagBtn = $("#copy-diagnostics-btn");
    if (copyDiagBtn) {
      copyDiagBtn.addEventListener("click", async () => {
        const originalText = copyDiagBtn.textContent;
        copyDiagBtn.disabled = true;
        const res = await copyDiagnostics();
        copyDiagBtn.textContent = res.success ? "✓ Copied to clipboard!" : "✓ Report generated!";
        setTimeout(() => {
          copyDiagBtn.textContent = originalText;
          copyDiagBtn.disabled = false;
        }, 2500);
      });
    }
  });
}
