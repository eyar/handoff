import { supabase } from "./supabaseClient.js";
import { state, getRole } from "./state.js";
import { $, setStatus, show, isDesktopComputer, isWindowsPlatform } from "./dom.js";
import { renderFiles, handleFileReady } from "./fileManager.js";
import { handleSyncedText, expireSharedText, updateTextExpiryUI } from "./textSync.js";
import { cleanupRoomStorage } from "./upload.js";
import { clearSavedComputerSession, setPaidSession } from "./session.js";
import { recordDiagnostic, logErrorToSupabase } from "./diagnostics.js";
import { updateUrlOpenerUI } from "./urlDetector.js";
import { encryptText } from "./crypto.js";
import { sealChannel } from "./sealedBroadcast.js";
import { notifyPairingChanged } from "./extensionBridge.js";
import { presenceMeta } from "./peers.js";

export function onPhoneConnected() {
  $("#qr")?.classList.add("hidden");
  const title = $("#computer-title");
  if (title) title.textContent = "Connected to phone";
  const kicker = $("#computer-kicker");
  if (kicker) kicker.textContent = "Active session";
  const timerEl = $("#timer");
  if (timerEl) {
    timerEl.textContent = "Live session";
    timerEl.className = "pill live-pill";
  }
  $("#computer-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
  $("#computer-divider")?.classList.add("hidden");
  setStatus($("#peer-status"), "Phone connected. Share text or files anytime.");
  notifyPairingChanged(true);
  if (state.desktopTextSync && $("#desktop-text")?.value?.trim()) {
    state.desktopTextSync.syncNow();
  }
}

export function onComputerConnected() {
  $("#qr")?.classList.add("hidden");
  const title = $("#computer-title");
  if (title) title.textContent = "Connected to computer";
  const kicker = $("#computer-kicker");
  if (kicker) kicker.textContent = "Computer-to-Computer session";
  const timerEl = $("#timer");
  if (timerEl) {
    timerEl.textContent = "Live session";
    timerEl.className = "pill live-pill";
  }
  $("#computer-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
  $("#computer-divider")?.classList.add("hidden");
  setStatus($("#peer-status"), "Connected to other computer. Share text or files anytime.");
  notifyPairingChanged(true);

  const sendBtn = $("#desktop-file-send");
  if (sendBtn) sendBtn.textContent = "Send files to other computer";

  const receivedLabel = $("#desktop-received-files-label");
  if (receivedLabel) receivedLabel.textContent = "Files from other computer";

  state.desktopFileUpload?.setTargetDeviceName?.("other computer");
  state.desktopTextSync?.setTargetDeviceName?.("other computer");

  if (state.desktopTextSync && $("#desktop-text")?.value?.trim()) {
    state.desktopTextSync.syncNow();
  }
}

export function resetComputerPairingUI() {
  $("#qr")?.classList.remove("hidden");
  const title = $("#computer-title");
  if (title) title.textContent = "Scan this with your phone.";
  const kicker = $("#computer-kicker");
  if (kicker) kicker.textContent = "Ready to pair";
  const timerEl = $("#timer");
  if (timerEl) {
    timerEl.textContent = "Waiting";
    timerEl.className = "pill";
  }
  $("#computer-divider")?.classList.remove("hidden");

  const sendBtn = $("#desktop-file-send");
  if (sendBtn) sendBtn.textContent = "Send files to phone";

  const receivedLabel = $("#desktop-received-files-label");
  if (receivedLabel) receivedLabel.textContent = "Files from your phone";

  state.desktopFileUpload?.setTargetDeviceName?.("phone");
  state.desktopTextSync?.setTargetDeviceName?.("phone");
  notifyPairingChanged(false);
}

export function setupRealtimeChannel(targetRoomId, role) {
  state.currentRole = role;
  recordDiagnostic("realtime", "Setting up channel", { roomId: targetRoomId, role });
  if (state.channel) {
    state.channel.unsubscribe();
    state.channel = null;
  }

  state.channel = sealChannel(supabase.channel(`handoff:${targetRoomId}`, {
    config: {
      broadcast: { self: false },
      presence: { key: `${role}:${state.deviceId}` }
    }
  }));

  state.channel
    .on("broadcast", { event: "peer:hello" }, async ({ payload }) => {
      recordDiagnostic("realtime", "Received peer:hello", { peerRole: payload?.role });
      if (role === "computer") {
        const isPeerComputer = payload?.role === "computer";
        if (isPeerComputer) {
          onComputerConnected();
        } else {
          onPhoneConnected();
        }

        const desktopText = $("#desktop-text")?.value || "";
        const peerText = payload?.currentText;

        if (peerText && (typeof peerText === "object" || peerText.trim()) && !desktopText.trim()) {
          await handleSyncedText(peerText, isPeerComputer ? "computer" : "phone", payload?.textExpiresAt);
        }

        if (Array.isArray(payload?.existingFiles)) {
          payload.existingFiles.forEach((filePayload) => {
            handleFileReady(filePayload, role);
          });
        }

        const now = Date.now();
        const activeFiles = state.sharedFiles
          .filter((f) => !f.expiresAt || f.expiresAt > now)
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
          }));

        const currentSyncText = $("#desktop-text")?.value || "";
        let syncTextToSend = currentSyncText;
        if (state.cryptoKey && currentSyncText) {
          try {
            syncTextToSend = await encryptText(currentSyncText, state.cryptoKey);
          } catch (err) {
            console.warn("Failed to encrypt ack text:", err);
          }
        }

        state.channel.send({
          type: "broadcast",
          event: "peer:ack",
          payload: {
            fromRole: "computer",
            deviceId: state.deviceId,
            isDesktopComputer: isDesktopComputer(),
            isWindows: isWindowsPlatform(),
            isSessionPaid: state.isSessionPaid,
            existingFiles: activeFiles,
            currentText: syncTextToSend,
            textExpiresAt: state.sharedTextExpiresAt
          }
        });

        if (state.desktopTextSync && currentSyncText.trim()) {
          setStatus($("#desktop-text-status"), isPeerComputer ? "✓ Synced with other computer" : "✓ Synced with phone");
        }
      }
    })
    .on("broadcast", { event: "peer:ack" }, async ({ payload }) => {
      const isPeerComputer = payload?.fromRole === "computer";
      if (role === "computer" && isPeerComputer) {
        onComputerConnected();
      }

      if (role === "phone" && typeof payload?.isDesktopComputer === "boolean") {
        const bridgePromptCard = $("#bridge-prompt-card");
        if (bridgePromptCard) {
          if (payload.isDesktopComputer && (state.qrFromComputer || new URLSearchParams(location.search).get("from") === "pc")) {
            bridgePromptCard.classList.remove("hidden");
          } else if (!payload.isDesktopComputer) {
            bridgePromptCard.classList.add("hidden");
          }
        }
      }

      if (role === "phone" && typeof payload?.isWindows === "boolean") {
        state.isTargetWindows = payload.isWindows;
      }

      if (role === "phone" || (role === "computer" && isPeerComputer)) {
        setStatus($("#phone-peer-status") || $("#phone-result") || $("#peer-status"), "");
        const timerEl = role === "phone" ? $("#phone-timer") : $("#timer");
        if (timerEl) {
          timerEl.textContent = "Live session";
          timerEl.className = "pill live-pill";
        }
        if (role === "phone") {
          $("#phone-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
        } else if (role === "computer") {
          $("#computer-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
        }
        if (payload?.isSessionPaid) {
          state.isSessionPaid = true;
          setPaidSession(state.roomId);
          state.activeFileUploadSetups.forEach((setup) => {
            if (typeof setup.render === "function") setup.render();
            else if (typeof setup === "function") setup();

            const staged = typeof setup.getStagedFiles === "function" ? setup.getStagedFiles() : [];
            if (staged.length > 0 && typeof setup.startUpload === "function") {
              setup.startUpload();
            }
          });
        }
        if (role === "phone" && isPeerComputer) {
          try {
            const rawPending = sessionStorage.getItem("handoff_pending_staged_file");
            if (rawPending) {
              const pendingFile = JSON.parse(rawPending);
              if (pendingFile?.id) {
                state.channel.send({
                  type: "broadcast",
                  event: "file:ready",
                  payload: {
                    fileId: pendingFile.id,
                    originalName: pendingFile.originalName,
                    mimeType: pendingFile.mimeType,
                    size: pendingFile.size,
                    downloadUrl: pendingFile.downloadUrl,
                    storagePath: pendingFile.storagePath,
                    senderDevice: "iPhone",
                    expiresAt: pendingFile.expiresAt,
                    isEncrypted: Boolean(pendingFile.isEncrypted)
                  }
                });
                sessionStorage.removeItem("handoff_pending_staged_file");
                const statusEl = $("#phone-peer-status") || $("#phone-result");
                if (statusEl) {
                  setStatus(statusEl, `✓ Sent "${pendingFile.originalName}" to your computer!`);
                }
                const badgeEl = $("#staged-card-badge");
                if (badgeEl) {
                  badgeEl.textContent = "✓ Sent";
                  badgeEl.className = "staged-card-badge delivered";
                }
                const promptEl = $("#staged-card-prompt");
                if (promptEl) {
                  promptEl.textContent = `✓ Sent "${pendingFile.originalName}" to your computer!`;
                }
                setTimeout(() => {
                  $("#staged-connect-details")?.classList.add("hidden");
                }, 1500);
              }
            }
          } catch (_) {}
        }
        if (Array.isArray(payload?.existingFiles)) {
          payload.existingFiles.forEach((filePayload) => {
            handleFileReady(filePayload, role);
          });
        }
        if (payload?.currentText && (typeof payload.currentText === "object" || payload.currentText.trim())) {
          await handleSyncedText(payload.currentText, isPeerComputer ? "computer" : "phone", payload?.textExpiresAt);
        } else if (role === "phone" && $("#phone-text")?.value?.trim()) {
          state.phoneTextSync?.syncNow();
        } else if (role === "computer" && $("#desktop-text")?.value?.trim()) {
          state.desktopTextSync?.syncNow();
        }
      }
    })
    .on("broadcast", { event: "room:redirect" }, async ({ payload }) => {
      if (payload?.targetRoomId) {
        if (typeof window.handleComputerBridgeRedirect === "function") {
          await window.handleComputerBridgeRedirect(payload.targetRoomId, payload?.cryptoKey);
        }
      }
    })
    .on("broadcast", { event: "bridge:pending" }, () => {
      if (role === "computer") {
        setStatus($("#peer-status"), "Connecting to 2nd computer…");
      }
    })
    .on("broadcast", { event: "file:expired" }, async ({ payload }) => {
      if (payload?.fileId) {
        const idx = state.sharedFiles.findIndex((f) => f.id === payload.fileId);
        if (idx !== -1) {
          const file = state.sharedFiles[idx];
          if (file.storagePath && state.roomUploadedFiles.has(file.storagePath)) {
            try {
              await supabase.functions.invoke("r2-sign", {
                body: { action: "delete", roomId: state.roomId, paths: [file.storagePath] }
              });
              state.roomUploadedFiles.delete(file.storagePath);
            } catch (err) {
              console.warn("Failed to delete expired file from R2:", err);
            }
          }
          state.sharedFiles.splice(idx, 1);
          state.selectedFileIds.delete(payload.fileId);
          renderFiles(state.sharedFiles);
        }
      }
    })
    .on("broadcast", { event: "file:completed" }, ({ payload }) => {
      const fileIds = Array.isArray(payload?.fileIds) ? payload.fileIds : [];
      const fileNames = Array.isArray(payload?.fileNames) ? payload.fileNames : [];
      const action = payload?.action || "downloaded";
      const byRole = payload?.byRole;
      const byDeviceName = byRole === "computer" ? "computer" : "phone";
      const delayMs = typeof payload?.delayMs === "number" ? payload.delayMs : 1500;

      const currentDeviceRole = getRole();
      const statusEl = currentDeviceRole === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
      const count = fileIds.length;

      if (action === "downloaded" && delayMs > 3500) {
        const downloadingMsg = count === 1 && fileNames[0]
          ? `Downloading "${fileNames[0]}" on ${byDeviceName}…`
          : `Downloading ${count} files on ${byDeviceName}…`;
        setStatus(statusEl, downloadingMsg);
      }

      setTimeout(async () => {
        const pathsToDelete = [];
        for (const fileId of fileIds) {
          const idx = state.sharedFiles.findIndex((f) => f.id === fileId);
          if (idx !== -1) {
            const file = state.sharedFiles[idx];
            if (file.storagePath && state.roomUploadedFiles.has(file.storagePath)) {
              pathsToDelete.push(file.storagePath);
              state.roomUploadedFiles.delete(file.storagePath);
            }
            state.sharedFiles.splice(idx, 1);
            state.selectedFileIds.delete(fileId);
          }
        }
        if (pathsToDelete.length > 0) {
          try {
            await supabase.functions.invoke("r2-sign", {
              body: { action: "delete", roomId: state.roomId, paths: pathsToDelete }
            });
          } catch (err) {
            console.warn("Failed to delete handed-off files from R2:", err);
          }
        }
        renderFiles(state.sharedFiles);

        const currentDeviceRole = getRole();
        const statusEl = currentDeviceRole === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
        const count = fileIds.length;
        const msg = count === 1 && fileNames[0]
          ? `✓ "${fileNames[0]}" was ${action} on ${byDeviceName}`
          : `✓ ${count} files were ${action} on ${byDeviceName}`;
        setStatus(statusEl, msg);
        setTimeout(() => {
          if (statusEl && statusEl.textContent === msg) {
            setStatus(statusEl, "");
          }
        }, 4000);
      }, delayMs);
    })
    .on("broadcast", { event: "text:sync" }, ({ payload }) => {
      if (payload?.text !== undefined && payload?.text !== null) {
        handleSyncedText(payload.text, role === "computer" ? "phone" : "computer", payload?.expiresAt);
      }
    })
    .on("broadcast", { event: "text:received" }, ({ payload }) => {
      if (payload?.text !== undefined && payload?.text !== null) {
        handleSyncedText(payload.text, role === "computer" ? "phone" : "computer", payload?.expiresAt);
      }
    })
    .on("broadcast", { event: "text:expired" }, () => {
      expireSharedText(false);
    })
    .on("broadcast", { event: "text:completed" }, ({ payload }) => {
      const byRole = payload?.byRole;
      const action = payload?.action || "copied";
      const delayMs = typeof payload?.delayMs === "number" ? payload.delayMs : 0;
      const byDeviceName = byRole === "computer" ? "computer" : "phone";

      setTimeout(() => {
        state.sharedTextExpiresAt = null;
        const desktopEl = $("#desktop-text");
        const phoneEl = $("#phone-text");

        if (desktopEl) desktopEl.value = "";
        if (phoneEl) phoneEl.value = "";

        state.desktopTextSync?.markAsSynced("");
        state.phoneTextSync?.markAsSynced("");

        updateTextExpiryUI();
        updateUrlOpenerUI({ role: "computer", text: "" });
        updateUrlOpenerUI({ role: "phone", text: "" });

        const currentDeviceRole = getRole();
        const statusEl = currentDeviceRole === "computer" ? $("#desktop-text-status") : $("#phone-result");
        const msg =
          action === "shared"
            ? `✓ Shared on ${byDeviceName}`
            : action === "opened"
            ? `✓ Opened on ${byDeviceName}`
            : `✓ Copied on ${byDeviceName}`;
        setStatus(statusEl, msg);
        setTimeout(() => {
          if (statusEl && statusEl.textContent === msg) {
            setStatus(statusEl, "");
          }
        }, 4000);
      }, delayMs);
    })
    .on("broadcast", { event: "file:upload_started" }, ({ payload }) => {
      if (payload?.fileId) {
        state.incomingFileTransfers.set(payload.fileId, payload);
        renderFiles(state.sharedFiles);
      }
      const peerStatusEl = role === "computer" ? $("#peer-status") : ($("#phone-peer-status") || $("#phone-result"));
      if (peerStatusEl && payload?.originalName) {
        setStatus(peerStatusEl, `Receiving "${payload.originalName}"…`);
      }
    })
    .on("broadcast", { event: "file:upload_cancelled" }, ({ payload }) => {
      if (payload?.fileId) {
        state.incomingFileTransfers.delete(payload.fileId);
        renderFiles(state.sharedFiles);
      }
      const peerStatusEl = role === "computer" ? $("#peer-status") : ($("#phone-peer-status") || $("#phone-result"));
      if (peerStatusEl) {
        if (!payload?.originalName || peerStatusEl.textContent.includes(payload.originalName)) {
          setStatus(peerStatusEl, "");
        }
      }
    })
    .on("broadcast", { event: "file:ready" }, ({ payload }) => {
      if (payload?.fileId) {
        state.incomingFileTransfers.delete(payload.fileId);
      }
      handleFileReady(payload, role);
      if (role === "computer" && payload?.fileId) {
        state.channel?.send({
          type: "broadcast",
          event: "file:ack",
          payload: {
            fileId: payload.fileId,
            originalName: payload.originalName
          }
        });
      }
    })
    .on("broadcast", { event: "file:ack" }, ({ payload }) => {
      if (role === "phone") {
        const badgeEl = $("#staged-card-badge");
        if (badgeEl) {
          badgeEl.textContent = "✓ Sent";
          badgeEl.className = "staged-card-badge delivered";
        }
        const promptEl = $("#staged-card-prompt");
        if (promptEl) {
          promptEl.textContent = `✓ Sent "${payload?.originalName || "file"}" to your computer!`;
        }
        const statusEl = $("#phone-peer-status") || $("#phone-result");
        if (statusEl) {
          setStatus(statusEl, `✓ Sent "${payload?.originalName || "file"}" to your computer!`);
        }
        try {
          sessionStorage.removeItem("handoff_pending_staged_file");
        } catch (_) {}
        setTimeout(() => {
          $("#staged-connect-details")?.classList.add("hidden");
        }, 1500);
      }
    })
    .on("broadcast", { event: "computer:ready" }, async ({ payload }) => {
      if (role === "computer" && payload?.deviceId && payload.deviceId !== state.deviceId) {
        onComputerConnected();
        const currentSyncText = $("#desktop-text")?.value || "";
        let syncTextToSend = currentSyncText;
        if (state.cryptoKey && currentSyncText) {
          try {
            syncTextToSend = await encryptText(currentSyncText, state.cryptoKey);
          } catch (err) {
            console.warn("Failed to encrypt computer:ready ack text:", err);
          }
        }
        state.channel.send({
          type: "broadcast",
          event: "peer:ack",
          payload: {
            fromRole: "computer",
            deviceId: state.deviceId,
            isSessionPaid: state.isSessionPaid,
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
            currentText: syncTextToSend,
            textExpiresAt: state.sharedTextExpiresAt
          }
        });
      } else if (role === "phone") {
        setStatus($("#phone-peer-status") || $("#phone-result"), "");
        const phoneTimer = $("#phone-timer");
        if (phoneTimer) {
          phoneTimer.textContent = "Live session";
          phoneTimer.className = "pill live-pill";
        }
        $("#phone-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
        const currentPhoneText = $("#phone-text")?.value || "";
        let phoneTextToSend = currentPhoneText;
        if (state.cryptoKey && currentPhoneText) {
          try {
            phoneTextToSend = await encryptText(currentPhoneText, state.cryptoKey);
          } catch (err) {
            console.warn("Failed to encrypt phone computer:ready text:", err);
          }
        }
        state.channel.send({
          type: "broadcast",
          event: "peer:hello",
          payload: {
            role: "phone",
            deviceId: state.deviceId,
            currentText: phoneTextToSend,
            textExpiresAt: state.sharedTextExpiresAt
          }
        });
        if (state.phoneTextSync && currentPhoneText.trim()) {
          state.phoneTextSync.syncNow();
        }
      }
    })
    .on("broadcast", { event: "room:ended" }, async () => {
      if (state.roomId) {
        await cleanupRoomStorage(state.roomId);
      }
      resetToHome("This handoff has ended.");
    })
    .on("presence", { event: "sync" }, async () => {
      const presState = state.channel.presenceState();
      const allPeers = Object.values(presState).flat();
      const otherComputer = allPeers.find((p) => p.role === "computer" && p.deviceId !== state.deviceId);
      const hasPhone = allPeers.some((p) => p.role === "phone");

      if (role === "computer") {
        if (otherComputer) {
          onComputerConnected();
          if (state.desktopTextSync && $("#desktop-text")?.value?.trim()) {
            state.desktopTextSync.syncNow();
          }
        } else if (hasPhone) {
          onPhoneConnected();
          if (state.desktopTextSync && $("#desktop-text")?.value?.trim()) {
            state.desktopTextSync.syncNow();
          }
        }
      } else if (role === "phone") {
        const hasComputer = allPeers.some((p) => p.role === "computer");
        state.onPhonePresence?.(hasComputer);
        if (hasComputer) {
          const phoneTitle = $("#phone-title");
          if (phoneTitle) {
            if (state.incomingFileTransfers.size > 0) {
              phoneTitle.textContent = "Receiving file…";
            } else if (state.sharedFiles.length > 0) {
              phoneTitle.textContent = "Files ready to download";
            } else {
              phoneTitle.textContent = "Connected to computer";
            }
          }
          setStatus($("#phone-peer-status") || $("#phone-result"), "");
          const phoneTimer = $("#phone-timer");
          if (phoneTimer) {
            phoneTimer.textContent = "Live session";
            phoneTimer.className = "pill live-pill";
          }
          $("#phone-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
          const currentPhoneText = $("#phone-text")?.value || "";
          let phoneTextToSend = currentPhoneText;
          if (state.cryptoKey && currentPhoneText) {
            try {
              phoneTextToSend = await encryptText(currentPhoneText, state.cryptoKey);
            } catch (err) {
              console.warn("Failed to encrypt phone presence text:", err);
            }
          }
          state.channel.send({
            type: "broadcast",
            event: "peer:hello",
            payload: {
              role: "phone",
              deviceId: state.deviceId,
              currentText: phoneTextToSend,
              textExpiresAt: state.sharedTextExpiresAt
            }
          });
          if (state.phoneTextSync && currentPhoneText.trim()) {
            state.phoneTextSync.syncNow();
          }
          // If a staged file is pending, transmit it to this computer!
          try {
            const rawPending = sessionStorage.getItem("handoff_pending_staged_file");
            if (rawPending) {
              const pendingFile = JSON.parse(rawPending);
              if (pendingFile?.id) {
                state.channel.send({
                  type: "broadcast",
                  event: "file:ready",
                  payload: {
                    fileId: pendingFile.id,
                    originalName: pendingFile.originalName,
                    mimeType: pendingFile.mimeType,
                    size: pendingFile.size,
                    downloadUrl: pendingFile.downloadUrl,
                    storagePath: pendingFile.storagePath,
                    senderDevice: "iPhone",
                    expiresAt: pendingFile.expiresAt,
                    isEncrypted: Boolean(pendingFile.isEncrypted)
                  }
                });
              }
            }
          } catch (_) {}
        }
      }
    });

  let channelErrorTimeout = null;

  state.channel.subscribe(async (status, err) => {
    recordDiagnostic("realtime", `Channel status: ${status}`, err ? { error: err?.message || String(err) } : null);
    if (status === "SUBSCRIBED") {
      if (channelErrorTimeout) {
        clearTimeout(channelErrorTimeout);
        channelErrorTimeout = null;
      }
      state.channel.track(presenceMeta(role));
      if (role === "computer") {
        $("#computer-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
        state.channel.send({
          type: "broadcast",
          event: "computer:ready",
          payload: { roomId: targetRoomId, deviceId: state.deviceId }
        });
        const desktopText = $("#desktop-text")?.value || "";
        let computerTextToSend = desktopText;
        if (state.cryptoKey && desktopText) {
          try {
            computerTextToSend = await encryptText(desktopText, state.cryptoKey);
          } catch (err) {
            console.warn("Failed to encrypt computer subscribe text:", err);
          }
        }
        state.channel.send({
          type: "broadcast",
          event: "peer:hello",
          payload: {
            role: "computer",
            deviceId: state.deviceId,
            currentText: computerTextToSend,
            textExpiresAt: state.sharedTextExpiresAt
          }
        });
      }
      if (role === "phone") {
        $("#phone-e2ee-badge")?.classList.toggle("hidden", !state.cryptoKey);
        const initialText = $("#phone-text")?.value || "";
        let phoneTextToSend = initialText;
        if (state.cryptoKey && initialText) {
          try {
            phoneTextToSend = await encryptText(initialText, state.cryptoKey);
          } catch (err) {
            console.warn("Failed to encrypt phone subscribe text:", err);
          }
        }
        const now = Date.now();
        const activeFiles = state.sharedFiles
          .filter((f) => !f.expiresAt || f.expiresAt > now)
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
          }));

        state.channel.send({
          type: "broadcast",
          event: "peer:hello",
          payload: {
            role: "phone",
            deviceId: state.deviceId,
            existingFiles: activeFiles,
            currentText: phoneTextToSend,
            textExpiresAt: initialText.trim() ? state.sharedTextExpiresAt : null
          }
        });
        setStatus($("#phone-peer-status") || $("#phone-result"), "");
      }
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      // Don't alert immediately on mobile tab switching or transient socket warmup.
      // Wait 5 seconds to verify if Supabase's automatic reconnection succeeds.
      if (!channelErrorTimeout) {
        channelErrorTimeout = setTimeout(() => {
          if (state.channel && state.channel.state !== "joined") {
            logErrorToSupabase("realtime_channel_error", err?.message || `Channel subscription ${status}`, {
              status,
              role,
              roomId: targetRoomId
            });
          }
          channelErrorTimeout = null;
        }, 5000);
      }
    }
  });

  return state.channel;
}

export async function endRoom() {
  const currentRoomId = state.roomId;
  clearSavedComputerSession(currentRoomId);
  if (state.channel) {
    state.channel.send({
      type: "broadcast",
      event: "room:ended",
      payload: { roomId: currentRoomId }
    });
    state.channel.unsubscribe();
    state.channel = null;
  }
  if (currentRoomId) {
    await cleanupRoomStorage(currentRoomId);
  }
  resetToHome();
}

export function resetToHome(notice) {
  clearSavedComputerSession();
  if (state.channel) {
    state.channel.unsubscribe();
    state.channel = null;
  }
  state.roomId = null;
  state.currentRole = null;
  state.isSessionPaid = false;
  state.activeCheckoutTransactionId = null;
  state.sharedFiles = [];
  state.incomingFileTransfers.clear();
  state.qrFromComputer = false;
  state.isTargetWindows = false;
  state.cryptoKey = null;
  state.cryptoKeyBase64 = null;
  state.isPeerE2ee = false;
  $("#computer-e2ee-badge")?.classList.add("hidden");
  $("#phone-e2ee-badge")?.classList.add("hidden");
  $("#bridge-prompt-card")?.classList.add("hidden");
  state.onPhonePresence?.(true);
  renderFiles([]);
  resetComputerPairingUI();

  if (state.desktopTextSync) {
    state.desktopTextSync.reset();
  } else if ($("#desktop-text")) {
    $("#desktop-text").value = "";
  }
  if (state.phoneTextSync) {
    state.phoneTextSync.reset();
  } else if ($("#phone-text")) {
    $("#phone-text").value = "";
  }
  state.sharedTextExpiresAt = null;
  updateTextExpiryUI();
  updateUrlOpenerUI({ role: "computer", text: "" });
  updateUrlOpenerUI({ role: "phone", text: "" });
  setStatus($("#desktop-text-status"), "");
  setStatus($("#phone-result"), "");
  setStatus($("#phone-peer-status"), "");

  if (location.search) {
    try {
      history.replaceState(null, "", location.pathname);
    } catch {
      location.href = location.pathname;
    }
  }
  show("home");
  if (notice) {
    const kicker = $("#home .kicker");
    if (kicker) {
      const prev = kicker.textContent;
      kicker.textContent = notice;
      setTimeout(() => {
        if (kicker.textContent === notice) kicker.textContent = prev;
      }, 4000);
    }
  }
}
