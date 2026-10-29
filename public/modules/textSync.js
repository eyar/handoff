import { state, getRole } from "./state.js";
import { $, setStatus, formatFileRemaining } from "./dom.js";
import { MAX_TEXT_LENGTH, TEXT_TTL_MS } from "./constants.js";
import { saveCachedText } from "./session.js";
import { updateUrlOpenerUI } from "./urlDetector.js";
import { encryptText, decryptText } from "./crypto.js";
import { otherPeers } from "./peers.js";
import { logTextTransfer } from "./usage.js";

export function updateTextExpiryUI(now = Date.now()) {
  const desktopBadge = $("#desktop-text-expiry");
  const phoneBadge = $("#phone-text-expiry");
  const desktopText = $("#desktop-text")?.value || "";
  const phoneText = $("#phone-text")?.value || "";
  const currentDeviceRole = getRole();
  const currentText = currentDeviceRole === "computer" ? desktopText : phoneText;

  if (!currentText.trim() || !state.sharedTextExpiresAt) {
    desktopBadge?.classList.add("hidden");
    phoneBadge?.classList.add("hidden");
    return;
  }

  const remainingSec = Math.max(0, Math.ceil((state.sharedTextExpiresAt - now) / 1000));
  if (remainingSec <= 0) {
    expireSharedText(true);
    return;
  }

  const timeFormatted = formatFileRemaining(state.sharedTextExpiresAt);
  const isSoon = remainingSec <= 15;

  [desktopBadge, phoneBadge].forEach((badge) => {
    if (!badge) return;
    badge.classList.remove("hidden");
    const timeSpan = badge.querySelector(".text-expiry-time");
    if (timeSpan) timeSpan.textContent = timeFormatted;
    if (isSoon) {
      badge.classList.add("expiring-soon");
    } else {
      badge.classList.remove("expiring-soon");
    }
  });
}

export function expireSharedText(notifyPeer = true) {
  state.sharedTextExpiresAt = null;

  const desktopEl = $("#desktop-text");
  const phoneEl = $("#phone-text");
  const hadText = Boolean(desktopEl?.value?.trim() || phoneEl?.value?.trim());

  if (desktopEl) desktopEl.value = "";
  if (phoneEl) phoneEl.value = "";

  state.desktopTextSync?.markAsSynced("");
  state.phoneTextSync?.markAsSynced("");
  if (state.roomId) {
    saveCachedText(state.roomId, "");
  }

  $("#desktop-text-expiry")?.classList.add("hidden");
  $("#phone-text-expiry")?.classList.add("hidden");
  updateUrlOpenerUI({ role: "computer", text: "" });
  updateUrlOpenerUI({ role: "phone", text: "" });

  if (hadText) {
    const currentDeviceRole = getRole();
    const statusEl = currentDeviceRole === "computer" ? $("#desktop-text-status") : $("#phone-result");
    setStatus(statusEl, "Text expired after 1 minute");
    setTimeout(() => {
      if (statusEl && statusEl.textContent === "Text expired after 1 minute") {
        setStatus(statusEl, "");
      }
    }, 4000);
  }

  if (notifyPeer && state.channel) {
    try {
      state.channel.send({
        type: "broadcast",
        event: "text:expired",
        payload: {}
      });
    } catch (err) {
      console.warn("Failed to broadcast text:expired:", err);
    }
  }
}

export async function handleSyncedText(text, sourceDeviceName, expiresAt) {
  const currentDeviceRole = getRole();
  const targetEl = currentDeviceRole === "computer" ? $("#desktop-text") : $("#phone-text");
  const statusEl = currentDeviceRole === "computer" ? $("#desktop-text-status") : $("#phone-result");
  if (!targetEl) return;

  const resolvedText = await decryptText(text, state.cryptoKey);
  const safeText = typeof resolvedText === "string" ? resolvedText : "";

  if (safeText.trim()) {
    state.sharedTextExpiresAt = typeof expiresAt === "number" ? expiresAt : (Date.now() + TEXT_TTL_MS);
  } else {
    state.sharedTextExpiresAt = null;
  }
  updateTextExpiryUI();
  updateUrlOpenerUI({
    role: currentDeviceRole,
    text: safeText,
    isRemote: true,
    sourceDeviceName
  });

  if (targetEl.value === safeText) return;

  const isFocused = document.activeElement === targetEl;
  const start = targetEl.selectionStart;

  targetEl.value = safeText;

  if (isFocused && typeof start === "number") {
    const newPos = Math.min(start, safeText.length);
    targetEl.setSelectionRange(newPos, newPos);
  }

  const activeSync = currentDeviceRole === "computer" ? state.desktopTextSync : state.phoneTextSync;
  if (activeSync) {
    activeSync.markAsSynced(safeText);
  }
  if (currentDeviceRole === "computer" && state.roomId) {
    saveCachedText(state.roomId, safeText);
  }

  if (safeText.trim()) {
    setStatus(statusEl, `✓ Updated from ${sourceDeviceName}`);
  } else {
    setStatus(statusEl, "");
  }
}

export async function handleReceivedText(text) {
  const currentDeviceRole = getRole();
  await handleSyncedText(text, currentDeviceRole === "computer" ? "phone" : "computer");
}

export async function sendText(text, resultElement) {
  if (!state.roomId || !state.channel) return;
  const content = typeof text === "string" ? text : "";
  if (content.length > MAX_TEXT_LENGTH) {
    return setStatus(resultElement, `Keep messages under ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
  }

  setStatus(resultElement, "Syncing…");
  try {
    const payloadToSend = (state.cryptoKey && content.trim())
      ? await encryptText(content, state.cryptoKey)
      : content;

    await state.channel.send({
      type: "broadcast",
      event: "text:received",
      payload: {
        text: payloadToSend,
        expiresAt: content.trim() ? state.sharedTextExpiresAt : null
      }
    });
    if (content.trim()) {
      logTextTransfer({ role: getRole(), peers: otherPeers() });
      setStatus(resultElement, "✓ Synced");
    } else {
      setStatus(resultElement, "");
    }
  } catch (err) {
    console.error("Text broadcast failed:", err);
    setStatus(resultElement, "Couldn’t sync. Try again.");
  }
}

export function setupLiveTextInput(textareaEl, statusEl, targetDeviceName) {
  if (!textareaEl) return null;

  let currentTargetDeviceName = targetDeviceName;
  let debounceTimer = null;
  let lastSentText = textareaEl.value;
  let isSending = false;

  async function syncNow() {
    clearTimeout(debounceTimer);
    debounceTimer = null;

    const currentText = textareaEl.value;
    if (currentText === lastSentText && !isSending) {
      return;
    }

    if (currentText.length > MAX_TEXT_LENGTH) {
      setStatus(statusEl, `Keep text under ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
      return;
    }

    if (currentText.trim()) {
      if (!state.sharedTextExpiresAt) {
        state.sharedTextExpiresAt = Date.now() + TEXT_TTL_MS;
      }
      updateTextExpiryUI();
    } else {
      state.sharedTextExpiresAt = null;
      updateTextExpiryUI();
    }

    if (!state.roomId || !state.channel) {
      if (currentText.trim()) {
        setStatus(statusEl, `Will sync when ${currentTargetDeviceName} connects.`);
      } else {
        setStatus(statusEl, "");
      }
      return;
    }

    if (isSending) {
      debounceTimer = setTimeout(syncNow, 100);
      return;
    }

    isSending = true;
    if (currentText.trim()) {
      setStatus(statusEl, "Syncing…");
    }

    try {
      const payloadToSend = (state.cryptoKey && currentText.trim())
        ? await encryptText(currentText, state.cryptoKey)
        : currentText;

      await state.channel.send({
        type: "broadcast",
        event: "text:sync",
        payload: {
          text: payloadToSend,
          expiresAt: currentText.trim() ? state.sharedTextExpiresAt : null
        }
      });
      lastSentText = currentText;
      if (currentText.trim()) logTextTransfer({ role: getRole(), peers: otherPeers() });
      if (getRole() === "computer" && state.roomId) {
        saveCachedText(state.roomId, currentText);
      }
      if (currentText.trim()) {
        setStatus(statusEl, `✓ Synced with ${currentTargetDeviceName}`);
      } else {
        setStatus(statusEl, "");
      }
    } catch (err) {
      console.error("Live text sync failed:", err);
      setStatus(statusEl, "Couldn’t sync. Reconnecting…");
    } finally {
      isSending = false;
      if (textareaEl.value !== lastSentText) {
        debounceTimer = setTimeout(syncNow, 100);
      }
    }
  }

  function queueSync(delay = 150) {
    clearTimeout(debounceTimer);
    const currentText = textareaEl.value;

    if (currentText === lastSentText) {
      return;
    }

    if (currentText.length > MAX_TEXT_LENGTH) {
      setStatus(statusEl, `Keep text under ${MAX_TEXT_LENGTH.toLocaleString()} characters.`);
      return;
    }

    if (currentText.trim()) {
      state.sharedTextExpiresAt = Date.now() + TEXT_TTL_MS;
      updateTextExpiryUI();
      updateUrlOpenerUI({
        role: getRole(),
        text: currentText,
        isRemote: false
      });
      if (!state.roomId || !state.channel) {
        setStatus(statusEl, `Will sync when ${targetDeviceName} connects.`);
      } else {
        setStatus(statusEl, "Syncing…");
      }
    } else {
      state.sharedTextExpiresAt = null;
      updateTextExpiryUI();
      updateUrlOpenerUI({
        role: getRole(),
        text: ""
      });
      if (!lastSentText) {
        setStatus(statusEl, "");
      }
    }

    debounceTimer = setTimeout(syncNow, delay);
  }

  textareaEl.addEventListener("input", () => queueSync(150));
  textareaEl.addEventListener("paste", () => queueSync(30));
  textareaEl.addEventListener("change", () => syncNow());
  textareaEl.addEventListener("blur", () => syncNow());

  return {
    syncNow,
    queueSync,
    onInput(delay = 50) {
      queueSync(delay);
    },
    markAsSynced(text) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      lastSentText = text;
    },
    reset() {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      lastSentText = "";
      isSending = false;
      textareaEl.value = "";
      setStatus(statusEl, "");
      updateUrlOpenerUI({
        role: getRole(),
        text: ""
      });
    },
    setTargetDeviceName(name) {
      currentTargetDeviceName = name;
    }
  };
}

export function onTextHandedOff({ action = "copied", role = getRole(), delayMs = 1200 } = {}) {
  const currentText = (role === "computer" ? $("#desktop-text")?.value : $("#phone-text")?.value) || "";
  if (!currentText.trim()) return;

  const actionPast = action === "shared" ? "shared" : action === "opened" ? "opened" : "copied";

  // Notify peer immediately over broadcast so peer knows text was accepted and can clear in sync
  if (state.channel) {
    try {
      state.channel.send({
        type: "broadcast",
        event: "text:completed",
        payload: {
          action: actionPast,
          byRole: role,
          delayMs
        }
      });
    } catch (err) {
      console.warn("Failed to broadcast text:completed:", err);
    }
  }

  // Clear locally after delayMs so user gets the tactile feedback before clearing
  setTimeout(() => {
    state.sharedTextExpiresAt = null;
    const desktopEl = $("#desktop-text");
    const phoneEl = $("#phone-text");

    if (desktopEl) desktopEl.value = "";
    if (phoneEl) phoneEl.value = "";

    state.desktopTextSync?.markAsSynced("");
    state.phoneTextSync?.markAsSynced("");
    if (state.roomId) {
      saveCachedText(state.roomId, "");
    }

    updateTextExpiryUI();
    updateUrlOpenerUI({ role: "computer", text: "" });
    updateUrlOpenerUI({ role: "phone", text: "" });

    const localStatusEl = role === "computer" ? $("#desktop-text-status") : $("#phone-result");
    const localMsg =
      actionPast === "shared"
        ? "✓ Shared and cleared"
        : actionPast === "opened"
        ? "✓ Opened link and cleared"
        : "✓ Copied to clipboard and cleared";
    setStatus(localStatusEl, localMsg);
    setTimeout(() => {
      if (localStatusEl && localStatusEl.textContent === localMsg) {
        setStatus(localStatusEl, "");
      }
    }, 3500);
  }, delayMs);
}
