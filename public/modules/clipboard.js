import { state, getRole } from "./state.js";
import { $, setStatus, isDesktopComputer } from "./dom.js";
import {
  getShareableFile,
  triggerFileDownload,
  onFileHandedOff,
  initiateBulkDownload
} from "./fileManager.js";
import { onTextHandedOff } from "./textSync.js";
import { MAX_SHARE_FILE_SIZE } from "./constants.js";

export function isTooLargeToShare(fileObj) {
  return Number(fileObj?.size) > MAX_SHARE_FILE_SIZE;
}

export function isCopyableFile(fileObj) {
  if (!fileObj) return false;
  const mime = fileObj.mimeType || fileObj.type || "";
  const name = fileObj.originalName || fileObj.name || "";
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(name);
  const isText = mime.startsWith("text/") || /\.(txt|json|md|csv|js|ts|html|css|py|sql|xml|ya?ml)$/i.test(name);
  return isImage || isText;
}

export function imageBlobToPngBlob(imgBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(imgBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width || 800;
        canvas.height = img.naturalHeight || img.height || 600;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not get 2D canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error("Canvas failed to create PNG blob"));
        }, "image/png");
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image failed to load for clipboard conversion"));
    };
    img.src = url;
  });
}

export async function copyTextToClipboard(text) {
  if (!text) return true;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn("navigator.clipboard.writeText failed, falling back to execCommand:", err);
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.width = "2em";
    textarea.style.height = "2em";
    textarea.style.padding = "0";
    textarea.style.border = "none";
    textarea.style.outline = "none";
    textarea.style.boxShadow = "none";
    textarea.style.background = "transparent";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const success = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (success) return true;
  } catch (err) {
    console.warn("document.execCommand('copy') failed:", err);
  }

  return false;
}

export async function copySingleFile(fileObj, buttonEl) {
  const originalHtml = buttonEl ? buttonEl.innerHTML : "";
  const setBtnText = (msg) => {
    if (buttonEl) {
      const span = buttonEl.querySelector(".share-selected-text") || buttonEl.querySelector("span");
      if (span) span.textContent = msg;
      else buttonEl.textContent = msg;
    }
  };

  try {
    setBtnText("Copying…");
    const file = await getShareableFile(fileObj);
    const blob = file || fileObj.blob;

    if (!blob) {
      triggerFileDownload(fileObj);
      setBtnText("Downloaded!");
      onFileHandedOff(fileObj, "downloaded", 1500);
      setTimeout(() => { if (buttonEl) buttonEl.innerHTML = originalHtml; }, 2000);
      return;
    }

    const mime = blob.type || fileObj.mimeType || "";
    const name = fileObj.originalName || "";
    const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(name);
    const isText = mime.startsWith("text/") || /\.(txt|json|md|csv|js|ts|html|css|py|sql|xml|ya?ml)$/i.test(name);

    if (isImage) {
      if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        let pngBlob = blob;
        if (blob.type !== "image/png") {
          pngBlob = await imageBlobToPngBlob(blob);
        }
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": pngBlob })
        ]);
        setBtnText("Copied!");
        onFileHandedOff(fileObj, "copied", 1200);
      } else {
        console.warn("navigator.clipboard.write is unavailable (requires a Secure Context such as HTTPS or localhost). Downloading image instead.");
        triggerFileDownload(fileObj);
        setBtnText("Downloaded!");
        onFileHandedOff(fileObj, "downloaded", 1500);
      }
    } else if (isText) {
      const text = await blob.text();
      const success = await copyTextToClipboard(text);
      if (success) {
        setBtnText("Copied!");
        onFileHandedOff(fileObj, "copied", 1200);
      } else {
        triggerFileDownload(fileObj);
        setBtnText("Downloaded!");
        onFileHandedOff(fileObj, "downloaded", 1500);
      }
    } else {
      triggerFileDownload(fileObj);
      setBtnText("Downloaded!");
      onFileHandedOff(fileObj, "downloaded", 1500);
    }
  } catch (err) {
    console.warn("Failed to copy file to clipboard, downloading instead:", err);
    triggerFileDownload(fileObj);
    setBtnText("Downloaded!");
    onFileHandedOff(fileObj, "downloaded", 1500);
  }

  setTimeout(() => {
    if (buttonEl) buttonEl.innerHTML = originalHtml;
  }, 2000);
}

export async function copyMultipleFiles(fileObjs, buttonEl) {
  if (!fileObjs || fileObjs.length === 0) return;
  await initiateBulkDownload(fileObjs, buttonEl);
}

export async function shareSingleFile(fileObj) {
  if (isTooLargeToShare(fileObj)) {
    triggerFileDownload(fileObj);
    onFileHandedOff(fileObj, "downloaded", 1500);
    return;
  }
  const file = await getShareableFile(fileObj);
  if (!file) {
    triggerFileDownload(fileObj);
    onFileHandedOff(fileObj, "downloaded", 1500);
    return;
  }

  const canShare = typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShare) {
    try {
      await navigator.share({
        files: [file],
        title: fileObj.originalName
      });
      onFileHandedOff(fileObj, "shared", 400);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("Single file share failed, downloading instead:", err);
        triggerFileDownload(fileObj);
        onFileHandedOff(fileObj, "downloaded", 1500);
      }
    }
  } else {
    triggerFileDownload(fileObj);
    onFileHandedOff(fileObj, "downloaded", 1500);
  }
}

export async function shareMultipleFiles(fileObjs) {
  if (!fileObjs || fileObjs.length === 0) return;
  if (fileObjs.some(isTooLargeToShare)) {
    await initiateBulkDownload(fileObjs);
    return;
  }
  const files = [];
  for (const f of fileObjs) {
    const file = await getShareableFile(f);
    if (file) files.push(file);
  }

  const canShare = typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files });

  if (canShare) {
    try {
      await navigator.share({
        files,
        title: `Shared ${files.length} files`
      });
      onFileHandedOff(fileObjs, "shared", 400);
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("Native share failed, falling back to download:", err);
        const isZip = isDesktopComputer() && fileObjs.length > 1;
        const delayMs = isZip ? 1500 : Math.max(1500, fileObjs.length * 350);
        if (isZip) {
          await downloadFilesAsZip(fileObjs);
        } else {
          downloadFilesSequentially(fileObjs, triggerFileDownload);
        }
        onFileHandedOff(fileObjs, "downloaded", delayMs);
      }
    }
  } else {
    const isZip = isDesktopComputer() && fileObjs.length > 1;
    const delayMs = isZip ? 1500 : Math.max(1500, fileObjs.length * 350);
    if (isZip) {
      await downloadFilesAsZip(fileObjs);
    } else {
      downloadFilesSequentially(fileObjs, triggerFileDownload);
    }
    onFileHandedOff(fileObjs, "downloaded", delayMs);
  }
}

export async function fallbackCopy(text, buttonEl, sourceRole = getRole()) {
  if (!buttonEl) return;
  const originalContent = buttonEl.innerHTML;
  try {
    const success = await copyTextToClipboard(text);
    if (success) {
      buttonEl.textContent = "Copied!";
      onTextHandedOff({ action: "copied", role: sourceRole, delayMs: 1200 });
    } else {
      buttonEl.textContent = "Copy failed";
    }
  } catch {
    buttonEl.textContent = "Copy failed";
  }
  setTimeout(() => {
    buttonEl.innerHTML = originalContent;
  }, 2000);
}

export async function shareText(text, buttonEl, sourceRole = getRole()) {
  if (!text) return;
  const trimmed = text.trim();
  let shareData = { text: trimmed };

  try {
    const url = new URL(trimmed);
    if ((url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(trimmed)) {
      shareData = { url: trimmed };
    }
  } catch {
    // Not a standalone URL
  }

  if (typeof navigator !== "undefined" && navigator.share) {
    try {
      if (navigator.canShare && !navigator.canShare(shareData)) {
        shareData = { text: trimmed };
      }
      await navigator.share(shareData);
      onTextHandedOff({ action: "shared", role: sourceRole, delayMs: 400 });
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("Share failed, falling back to copy:", err);
        await fallbackCopy(trimmed, buttonEl, sourceRole);
      }
    }
  } else {
    await fallbackCopy(trimmed, buttonEl, sourceRole);
  }
}

export async function handleTextCopy(textareaSelector, buttonEl, sourceRole = getRole()) {
  const text = $(textareaSelector)?.value || "";
  const span = buttonEl?.querySelector("span");
  if (!text.trim()) {
    const originalText = span ? span.textContent : (buttonEl?.textContent || "Copy to clipboard");
    if (span) span.textContent = "Nothing to copy";
    else if (buttonEl) buttonEl.textContent = "Nothing to copy";
    setTimeout(() => {
      if (span) span.textContent = originalText;
      else if (buttonEl) buttonEl.textContent = originalText;
    }, 1500);
    return;
  }

  const originalContent = buttonEl?.innerHTML;
  try {
    const success = await copyTextToClipboard(text);
    if (success) {
      if (span) span.textContent = "Copied!";
      else if (buttonEl) buttonEl.textContent = "Copied!";
      onTextHandedOff({ action: "copied", role: sourceRole, delayMs: 1200 });
    } else {
      if (span) span.textContent = "Copy failed";
      else if (buttonEl) buttonEl.textContent = "Copy failed";
    }
  } catch (err) {
    console.warn("Failed to copy text:", err);
    if (span) span.textContent = "Copy failed";
    else if (buttonEl) buttonEl.textContent = "Copy failed";
  }
  setTimeout(() => {
    if (buttonEl && originalContent) buttonEl.innerHTML = originalContent;
  }, 2000);
}

export async function handleTextAction(textareaSelector, buttonEl, sourceRole = getRole()) {
  const text = $(textareaSelector)?.value || "";
  if (isDesktopComputer()) {
    await handleTextCopy(textareaSelector, buttonEl, sourceRole);
  } else {
    if (!text.trim()) {
      const span = buttonEl?.querySelector("span");
      const originalText = span ? span.textContent : (buttonEl?.textContent || "Share");
      if (span) span.textContent = "Nothing to share";
      else if (buttonEl) buttonEl.textContent = "Nothing to share";
      setTimeout(() => {
        if (span) span.textContent = originalText;
        else if (buttonEl) buttonEl.textContent = originalText;
      }, 1500);
      return;
    }
    await shareText(text, buttonEl, sourceRole);
  }
}

export function normalizePastedFile(file, index = 0) {
  if (!file.name || file.name === "image.png" || file.name === "blob") {
    const ext = file.type ? file.type.split("/")[1]?.replace("+xml", "") || "png" : "png";
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(11, 19);
    const newName = `pasted-image-${dateStr}${index > 0 ? `-${index + 1}` : ""}.${ext}`;
    return new File([file], newName, { type: file.type || "image/png", lastModified: Date.now() });
  }
  return file;
}

export function extractFilesFromClipboardEvent(event) {
  const files = [];
  if (event.clipboardData?.files?.length) {
    for (let i = 0; i < event.clipboardData.files.length; i++) {
      files.push(event.clipboardData.files[i]);
    }
  } else if (event.clipboardData?.items?.length) {
    for (let i = 0; i < event.clipboardData.items.length; i++) {
      const item = event.clipboardData.items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files;
}

export function handleGlobalPaste(e) {
  if (!state.roomId) return;

  const currentRole = getRole();
  const fileUpload = currentRole === "computer" ? state.desktopFileUpload : state.phoneFileUpload;
  const textEl = currentRole === "computer" ? $("#desktop-text") : $("#phone-text");
  const textSync = currentRole === "computer" ? state.desktopTextSync : state.phoneTextSync;
  const fileStatusEl = currentRole === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
  const textStatusEl = currentRole === "computer" ? $("#desktop-text-status") : $("#phone-result");

  const files = extractFilesFromClipboardEvent(e);

  if (files.length > 0) {
    e.preventDefault();
    const normalizedFiles = files.map((f, idx) => normalizePastedFile(f, idx));
    fileUpload?.addFiles(normalizedFiles);
    setStatus(fileStatusEl, `✓ Pasted ${normalizedFiles.length} file${normalizedFiles.length > 1 ? "s" : ""}`);
    setTimeout(() => {
      if (fileStatusEl && fileStatusEl.textContent.startsWith("✓ Pasted")) {
        setStatus(fileStatusEl, "");
      }
    }, 4000);
    return;
  }

  const text = e.clipboardData?.getData("text/plain");
  if (text && text.trim()) {
    const activeEl = document.activeElement;
    const isTargetTextarea = activeEl === textEl;

    if (isTargetTextarea) {
      return;
    }

    e.preventDefault();
    if (textEl) {
      textEl.value = text;
      textEl.dispatchEvent(new Event("input", { bubbles: true }));
      try {
        if (typeof textSync?.syncNow === "function") {
          textSync.syncNow();
        } else if (typeof textSync?.onInput === "function") {
          textSync.onInput();
        }
      } catch (syncErr) {
        console.warn("Failed to sync pasted text:", syncErr);
      }
      textEl.focus();
      setStatus(textStatusEl, "✓ Pasted text to shared text");
      setTimeout(() => {
        if (textStatusEl && textStatusEl.textContent === "✓ Pasted text to shared text") {
          setStatus(textStatusEl, "");
        }
      }, 3500);
    }
  }
}

export async function handleFilePaste(buttonEl, targetRole = getRole()) {
  const isComputer = targetRole === "computer";
  const fileUpload = isComputer ? state.desktopFileUpload : state.phoneFileUpload;
  const textareaEl = document.getElementById(isComputer ? "desktop-text" : "phone-text");
  const textSync = isComputer ? state.desktopTextSync : state.phoneTextSync;
  const fileStatusEl = document.getElementById(isComputer ? "desktop-file-status" : "phone-file-status");
  const textStatusEl = document.getElementById(isComputer ? "desktop-text-status" : "phone-result");

  const originalHtml = buttonEl ? buttonEl.innerHTML : "";
  const setBtnStatus = (msg) => {
    if (buttonEl) {
      const span = buttonEl.querySelector("span");
      if (span) span.textContent = msg;
      else buttonEl.textContent = msg;
    }
  };

  if (typeof navigator === "undefined" || !navigator.clipboard) {
    setBtnStatus("Insecure context");
    setStatus(fileStatusEl, isComputer ? "Clipboard requires HTTPS. Click above to choose files." : "Clipboard requires HTTPS. Tap above to select photos.");
    setTimeout(() => { if (buttonEl) buttonEl.innerHTML = originalHtml; }, 2500);
    return;
  }

  let files = [];
  let textContent = "";

  try {
    setBtnStatus("Reading…");

    if (navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("image/")) {
              const blob = await item.getType(type);
              const ext = type.split("/")[1]?.replace("+xml", "") || "png";
              const file = new File([blob], `pasted-photo-${Date.now()}.${ext}`, { type });
              files.push(file);
            } else if (type === "text/plain") {
              const blob = await item.getType(type);
              textContent = await blob.text();
            }
          }
        }
      } catch (readErr) {
        console.warn("navigator.clipboard.read failed, checking readText:", readErr);
      }
    }

    if (files.length === 0 && !textContent.trim() && navigator.clipboard.readText) {
      textContent = await navigator.clipboard.readText();
    }
  } catch (err) {
    console.warn(`Failed to read clipboard on ${targetRole}:`, err);
    const isPermissionError = err.name === "NotAllowedError" || err.name === "SecurityError";
    setBtnStatus(isPermissionError ? "Permission denied" : "Paste error");
    setStatus(
      fileStatusEl,
      isPermissionError
        ? (isComputer ? "Clipboard access denied. Press Cmd+V / Ctrl+V to paste." : "Clipboard access denied. Tap above to select photos.")
        : (isComputer ? "Could not read clipboard. Click above to choose files." : "Could not read clipboard. Tap above to select photos.")
    );
    setTimeout(() => { if (buttonEl) buttonEl.innerHTML = originalHtml; }, 2500);
    return;
  }

  try {
    if (files.length > 0) {
      fileUpload?.addFiles(files);
      setBtnStatus("Pasted photo!");
      setStatus(fileStatusEl, `✓ Pasted ${files.length} photo${files.length > 1 ? "s" : ""}`);
    } else if (textContent.trim()) {
      if (textareaEl) {
        textareaEl.value = textContent;
        textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
        try {
          if (typeof textSync?.syncNow === "function") {
            textSync.syncNow();
          } else if (typeof textSync?.onInput === "function") {
            textSync.onInput();
          }
        } catch (syncErr) {
          console.warn("Failed to sync pasted text:", syncErr);
        }
        textareaEl.focus();
      }
      setBtnStatus("Pasted text!");
      setStatus(textStatusEl, "✓ Pasted text to shared text");
      setStatus(fileStatusEl, "✓ Clipboard contained text — pasted to shared text below");
    } else {
      setBtnStatus("Clipboard empty");
      setStatus(fileStatusEl, "Nothing found in clipboard.");
    }
  } catch (err) {
    console.error(`Failed to process clipboard items on ${targetRole}:`, err);
    setBtnStatus("Error");
    setStatus(fileStatusEl, "Error handling pasted content.");
  }

  setTimeout(() => {
    if (buttonEl) buttonEl.innerHTML = originalHtml;
  }, 2500);
}

export async function handleTextPaste(buttonEl, targetRole = getRole()) {
  const isComputer = targetRole === "computer";
  const fileUpload = isComputer ? state.desktopFileUpload : state.phoneFileUpload;
  const textareaEl = document.getElementById(isComputer ? "desktop-text" : "phone-text");
  const textSync = isComputer ? state.desktopTextSync : state.phoneTextSync;
  const fileStatusEl = document.getElementById(isComputer ? "desktop-file-status" : "phone-file-status");
  const textStatusEl = document.getElementById(isComputer ? "desktop-text-status" : "phone-result");

  const originalHtml = buttonEl ? buttonEl.innerHTML : "";
  const setBtnStatus = (msg) => {
    if (buttonEl) {
      const span = buttonEl.querySelector("span");
      if (span) span.textContent = msg;
      else buttonEl.textContent = msg;
    }
  };

  if (typeof navigator === "undefined" || !navigator.clipboard) {
    setBtnStatus(isComputer ? "Insecure context" : "Tap & hold box");
    setStatus(textStatusEl, isComputer ? "Clipboard requires HTTPS. Press Cmd+V / Ctrl+V to paste." : "Clipboard requires HTTPS. Tap & hold inside the box to paste.");
    setTimeout(() => { if (buttonEl) buttonEl.innerHTML = originalHtml; }, 2500);
    return;
  }

  let text = "";
  let files = [];

  try {
    setBtnStatus("Pasting…");

    if (navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith("image/")) {
              const blob = await item.getType(type);
              const ext = type.split("/")[1]?.replace("+xml", "") || "png";
              const file = new File([blob], `pasted-photo-${Date.now()}.${ext}`, { type });
              files.push(file);
            } else if (type === "text/plain") {
              const blob = await item.getType(type);
              text = await blob.text();
            }
          }
        }
      } catch (readErr) {
        console.warn("navigator.clipboard.read failed, trying readText:", readErr);
      }
    }

    if (!text && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch (err) {
    console.warn(`Failed to read clipboard on ${targetRole}:`, err);
    const isPermissionError = err.name === "NotAllowedError" || err.name === "SecurityError";
    setBtnStatus(isPermissionError ? "Permission denied" : "Paste failed");
    setStatus(
      textStatusEl,
      isPermissionError
        ? (isComputer ? "Clipboard access denied. Press Cmd+V / Ctrl+V in box to paste." : "Clipboard access denied. Tap & hold in box to paste.")
        : (isComputer ? "Could not read clipboard. Press Cmd+V / Ctrl+V in box to paste." : "Could not read clipboard. Tap & hold in box to paste.")
    );
    setTimeout(() => {
      if (buttonEl) buttonEl.innerHTML = originalHtml;
    }, 2000);
    return;
  }

  try {
    if (files.length > 0 && !text.trim()) {
      fileUpload?.addFiles(files);
      setBtnStatus("Pasted photo!");
      setStatus(fileStatusEl, "✓ Pasted photo from clipboard");
      setStatus(textStatusEl, "✓ Clipboard had a photo — uploaded to files above");
    } else if (text.trim()) {
      if (textareaEl) {
        textareaEl.value = text;
        textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
        try {
          if (typeof textSync?.syncNow === "function") {
            textSync.syncNow();
          } else if (typeof textSync?.onInput === "function") {
            textSync.onInput();
          }
        } catch (syncErr) {
          console.warn("Failed to sync pasted text:", syncErr);
        }
        textareaEl.focus();
      }
      setBtnStatus("Pasted!");
      setStatus(textStatusEl, "✓ Pasted from clipboard");
    } else {
      setBtnStatus("Nothing to paste");
      setStatus(textStatusEl, "Nothing found in clipboard.");
    }
  } catch (err) {
    console.error(`Failed to handle pasted text on ${targetRole}:`, err);
    setBtnStatus("Pasted!");
    setStatus(textStatusEl, "✓ Pasted locally");
  }

  setTimeout(() => {
    if (buttonEl) buttonEl.innerHTML = originalHtml;
  }, 2000);
}

export const handlePhoneFilePaste = (btn) => handleFilePaste(btn, "phone");
export const handlePhoneTextPaste = (btn) => handleTextPaste(btn, "phone");
export const handleDesktopFilePaste = (btn) => handleFilePaste(btn, "computer");
export const handleDesktopTextPaste = (btn) => handleTextPaste(btn, "computer");

export function setupDesktopDropzoneContextMenu() {
  const dropzone = $("#desktop-dropzone");
  const menu = $("#dropzone-context-menu");
  const pasteBtn = $("#dropzone-paste-btn");
  if (!dropzone || !menu || !pasteBtn) return;

  dropzone.addEventListener("contextmenu", (e) => {
    if (!state.roomId) return;
    e.preventDefault();
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;
    menu.classList.remove("hidden");
  });

  const closeMenu = () => menu.classList.add("hidden");

  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== dropzone) {
      closeMenu();
    }
  });

  window.addEventListener("scroll", closeMenu, { passive: true });

  pasteBtn.addEventListener("click", async () => {
    closeMenu();
    handleFilePaste(pasteBtn, "computer");
  });
}

export function applyDeviceButtonCustomizations() {
  const isComputer = isDesktopComputer();
  const dividerSpan = $("#computer-divider span");
  if (!isComputer && dividerSpan) {
    dividerSpan.textContent = "or share from this phone";
  }

  if (isComputer) {
    [$("#share"), $("#phone-share")].forEach((btn) => {
      if (!btn) return;
      btn.title = "Copy to clipboard";
      btn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>Copy to clipboard</span>
      `;
    });
    $("#copy")?.classList.add("hidden");
    $("#phone-copy")?.classList.add("hidden");

    $("#desktop-share-selected")?.classList.add("hidden");
    $("#phone-share-selected")?.classList.add("hidden");
  } else {
    [$("#share"), $("#phone-share")].forEach((btn) => {
      if (!btn) return;
      btn.title = "Share";
      btn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
          <polyline points="16 6 12 2 8 6"></polyline>
          <line x1="12" y1="2" x2="12" y2="15"></line>
        </svg>
        <span>Share</span>
      `;
    });
    $("#copy")?.classList.remove("hidden");
    $("#phone-copy")?.classList.remove("hidden");

    $("#desktop-share-selected")?.classList.remove("hidden");
    $("#phone-share-selected")?.classList.remove("hidden");
    [$("#desktop-share-selected"), $("#phone-share-selected")].forEach((btn) => {
      if (!btn) return;
      btn.title = "Share selected files";
      const icon = btn.querySelector(".btn-icon");
      if (icon) {
        icon.innerHTML = `<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line>`;
      }
    });
  }
}
