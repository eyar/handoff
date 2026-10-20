import { state, getRole } from "./state.js";
import { supabase } from "./supabaseClient.js";
import { FILE_TTL_MS, MAX_FILE_SIZE } from "./constants.js";
import {
  $,
  escapeHtml,
  formatBytes,
  getFileEmoji,
  formatFileRemaining,
  setStatus,
  isDesktopComputer
} from "./dom.js";
import { downloadFilesAsZip, downloadFilesSequentially } from "./zip.js";
import { isCopyableFile, copySingleFile, shareSingleFile, isTooLargeToShare } from "./clipboard.js";
import { saveCachedFiles } from "./session.js";
import { decryptFile } from "./crypto.js";
import { isChunkedFormat, decryptChunkedStream, decryptChunkedToBlob } from "./chunkedCrypto.js";
import { canDecryptToDisk, decryptStreamToDisk } from "./diskDecrypt.js";

// Encrypted files above this size stream straight to disk where the browser allows it (Chrome/Edge desktop)
const STREAM_TO_DISK_MIN_BYTES = 200 * 1024 * 1024;
// Chunked-encrypted files above this size decrypt into on-device storage instead of memory when the browser
// supports it (iPhone Safari reloads the page at ~500 MB in memory but handles 1 GB+ on disk)
const DECRYPT_TO_DISK_MIN_BYTES = 100 * 1024 * 1024;
// Image previews of encrypted files are only decrypted automatically up to this size
const AUTO_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

// Clean compatibility stubs: all files are free and directly accessible
export function isLockedFile() {
  return false;
}

export async function releaseHeldFiles() {}

export async function deleteHeldFiles() {}

async function deleteFromStorage(paths) {
  if (!paths || paths.length === 0 || !state.roomId) return;
  try {
    await supabase.functions.invoke("r2-sign", {
      body: { action: "delete", roomId: state.roomId, paths }
    });
  } catch (err) {
    console.warn("Failed to delete files from R2:", err);
  }
}

/**
 * Fetches an encrypted file and tells the two formats apart by their first bytes:
 * chunked files come back as a stream (decrypted chunk by chunk), single-shot files as a Blob.
 */
async function openEncryptedDownload(fileObj) {
  const resp = await fetch(fileObj.downloadUrl, { cache: "no-store" });
  if (!resp.ok || !resp.body) throw new Error(`Download failed (${resp.status})`);
  const reader = resp.body.getReader();
  const peeked = [];
  let peekedBytes = 0;
  let done = false;
  while (peekedBytes < 4 && !done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) done = true;
    else if (value?.byteLength) {
      peeked.push(value);
      peekedBytes += value.byteLength;
    }
  }
  const head = new Uint8Array(Math.min(peekedBytes, 4));
  let offset = 0;
  for (const piece of peeked) {
    if (offset >= head.byteLength) break;
    const used = Math.min(piece.byteLength, head.byteLength - offset);
    head.set(piece.subarray(0, used), offset);
    offset += used;
  }

  // Re-assemble the full stream: the bytes already read, then the rest
  const stream = new ReadableStream({
    pull(controller) {
      if (peeked.length) return controller.enqueue(peeked.shift());
      if (done) return controller.close();
      return reader.read().then(({ value, done: streamDone }) => {
        if (streamDone) controller.close();
        else controller.enqueue(value);
      });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  if (isChunkedFormat(head)) return { chunked: true, stream };
  return { chunked: false, blob: await new Response(stream).blob() };
}

/** `onProgress(decryptedBytes, totalBytes)` is reported for chunked files. */
export async function ensureDecryptedBlob(fileObj, onProgress) {
  if (!fileObj) return null;
  if (fileObj.blob instanceof Blob) return fileObj.blob;
  if (!fileObj.downloadUrl) return null;
  // A thumbnail and a Download tap can ask at the same time; decrypt once
  if (fileObj.decrypting) return fileObj.decrypting;
  fileObj.decrypting = (async () => {
    let blob;
    if (fileObj.isEncrypted && state.cryptoKey) {
      const download = await openEncryptedDownload(fileObj);
      if (!download.chunked) {
        blob = await decryptFile(download.blob, state.cryptoKey, fileObj.mimeType);
      } else if (fileObj.size > DECRYPT_TO_DISK_MIN_BYTES && canDecryptToDisk()) {
        blob = await decryptStreamToDisk(download.stream, state.cryptoKey, fileObj, onProgress);
      } else {
        blob = await decryptChunkedToBlob(download.stream, state.cryptoKey, fileObj.mimeType);
      }
    } else {
      blob = await (await fetch(fileObj.downloadUrl)).blob();
    }
    fileObj.blob = blob;
    return blob;
  })();
  try {
    return await fileObj.decrypting;
  } finally {
    fileObj.decrypting = null;
  }
}

/**
 * Large encrypted files on Chrome/Edge desktop: decrypt while downloading, straight into a file the user
 * picks, so memory stays flat even at 1.5 GB. Must be called directly from the click (the Save dialog
 * needs the user gesture). Returns false if streaming isn't available, so the caller can fall back.
 */
async function streamEncryptedToDisk(fileObj, onProgress) {
  if (typeof window.showSaveFilePicker !== "function") return false;
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: fileObj.originalName });
  } catch (err) {
    if (err?.name === "AbortError") return true; // user cancelled the Save dialog
    return false;
  }
  const writable = await handle.createWritable();
  try {
    const download = await openEncryptedDownload(fileObj);
    if (download.chunked) {
      let written = 0;
      for await (const chunk of decryptChunkedStream(download.stream, state.cryptoKey)) {
        await writable.write(chunk);
        written += chunk.byteLength;
        onProgress?.(written, fileObj.size);
      }
    } else {
      await writable.write(await decryptFile(download.blob, state.cryptoKey, fileObj.mimeType));
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
  return true;
}

export async function getShareableFile(fileObj) {
  if (fileObj.file instanceof File) return fileObj.file;
  if (fileObj.blob instanceof File) {
    fileObj.file = fileObj.blob;
    return fileObj.file;
  }
  if (fileObj.blob instanceof Blob) {
    const file = new File([fileObj.blob], fileObj.originalName, {
      type: fileObj.mimeType || "application/octet-stream",
      lastModified: Date.now()
    });
    fileObj.file = file;
    return file;
  }
  if (fileObj.downloadUrl) {
    try {
      const blob = await ensureDecryptedBlob(fileObj);
      if (blob) {
        const file = new File([blob], fileObj.originalName, {
          type: fileObj.mimeType || "application/octet-stream",
          lastModified: Date.now()
        });
        fileObj.file = file;
        return file;
      }
    } catch (e) {
      console.error("Failed to convert file for sharing:", e);
    }
  }
  return null;
}

export async function triggerFileDownload(fileObj) {
  if (fileObj.isEncrypted && !fileObj.blob) {
    await ensureDecryptedBlob(fileObj);
  }
  let url = fileObj.downloadUrl;
  let revokeUrl = false;
  if (fileObj.blob instanceof Blob) {
    url = URL.createObjectURL(fileObj.blob);
    revokeUrl = true;
  } else if (url && !url.startsWith("blob:") && !url.includes("download=") && !url.includes("X-Amz-") && !url.includes("response-content-disposition")) {
    url += (url.includes("?") ? "&" : "?") + `download=${encodeURIComponent(fileObj.originalName)}`;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = fileObj.originalName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revokeUrl) {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export function calculateFileHandOffDelay(fileOrFiles, action = "downloaded") {
  if (action === "shared") return 500;
  if (action === "copied") return 1200;

  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(Boolean);
  const totalBytes = files.reduce((acc, f) => acc + (Number(f?.size) || 0), 0);

  // The browser streams the download straight from storage, so deleting the object
  // early can cut it off mid-transfer (a 1.5GB video stopped at ~900MB on iOS).
  // Estimate a slow 1 MB/s plus 10 seconds of buffer, with no upper cap; the file's
  // own TTL still bounds how long it lives.
  const estimatedSec = Math.ceil(totalBytes / (1024 * 1024));
  const calculatedMs = (estimatedSec + 10) * 1000;
  return Math.max(4000, calculatedMs);
}

export function onFileHandedOff(fileOrFiles, action = "downloaded", customDelayMs = null) {
  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(Boolean);
  if (files.length === 0) return;

  const role = getRole();
  const fileIds = files.map((f) => f.id);
  const fileNames = files.map((f) => f.originalName);
  const actionPast = action === "shared" ? "shared" : action === "copied" ? "copied" : "downloaded";
  const estimatedMs = calculateFileHandOffDelay(files, action);
  // Downloads never get less time than the estimate, whatever the caller passed.
  const delayMs = typeof customDelayMs === "number"
    ? (actionPast === "downloaded" ? Math.max(customDelayMs, estimatedMs) : customDelayMs)
    : estimatedMs;

  // Broadcast to peer immediately so the other device gets notified and removes the files in sync
  if (state.channel) {
    try {
      state.channel.send({
        type: "broadcast",
        event: "file:completed",
        payload: {
          fileIds,
          fileNames,
          action: actionPast,
          byRole: role,
          delayMs
        }
      });
    } catch (err) {
      console.warn("Failed to broadcast file:completed:", err);
    }
  }

  // Show immediate status on downloader's device
  const statusEl = role === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
  if (actionPast === "downloaded" && delayMs > 3500) {
    const downloadingMsg = files.length === 1
      ? `Downloading "${fileNames[0]}"… will be removed once finished`
      : `Downloading ${files.length} files… will be removed once finished`;
    setStatus(statusEl, downloadingMsg);
  }

  // Remove locally after delayMs so that browser download manager has initiated and streamed the transfer
  setTimeout(async () => {
    const pathsToDelete = [];
    for (const file of files) {
      const idx = state.sharedFiles.findIndex((f) => f.id === file.id);
      if (idx !== -1) {
        if (file.storagePath && state.roomUploadedFiles.has(file.storagePath)) {
          pathsToDelete.push(file.storagePath);
          state.roomUploadedFiles.delete(file.storagePath);
        }
        state.sharedFiles.splice(idx, 1);
        state.selectedFileIds.delete(file.id);
      }
    }
    if (pathsToDelete.length > 0) {
      deleteFromStorage(pathsToDelete);
    }
    renderFiles(state.sharedFiles);

    const localMsg = files.length === 1
      ? `✓ "${fileNames[0]}" ${actionPast} and removed`
      : `✓ ${files.length} files ${actionPast} and removed`;
    setStatus(statusEl, localMsg);
    setTimeout(() => {
      if (statusEl && statusEl.textContent === localMsg) {
        setStatus(statusEl, "");
      }
    }, 3500);
  }, delayMs);
}

export async function removeSharedFiles(fileOrFiles) {
  const files = (Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles]).filter(Boolean);
  if (files.length === 0) return;

  const role = getRole();
  const fileIds = files.map((f) => f.id);
  const fileNames = files.map((f) => f.originalName);

  if (state.channel) {
    try {
      state.channel.send({
        type: "broadcast",
        event: "file:completed",
        payload: {
          fileIds,
          fileNames,
          action: "removed",
          byRole: role,
          delayMs: 0
        }
      });
    } catch (err) {
      console.warn("Failed to broadcast file removal:", err);
    }
  }

  const pathsToDelete = [];
  for (const file of files) {
    if (file.storagePath) {
      pathsToDelete.push(file.storagePath);
      state.roomUploadedFiles.delete(file.storagePath);
    }
    const idx = state.sharedFiles.findIndex((f) => f.id === file.id);
    if (idx !== -1) {
      state.sharedFiles.splice(idx, 1);
    }
    state.selectedFileIds.delete(file.id);
  }

  if (pathsToDelete.length > 0) {
    deleteFromStorage(pathsToDelete);
  }

  renderFiles(state.sharedFiles);

  const statusEl = role === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
  const localMsg = files.length === 1
    ? `✓ "${fileNames[0]}" removed`
    : `✓ ${files.length} files removed`;
  setStatus(statusEl, localMsg);
  setTimeout(() => {
    if (statusEl && statusEl.textContent === localMsg) {
      setStatus(statusEl, "");
    }
  }, 3500);
}

export async function expireFile(fileId) {
  const idx = state.sharedFiles.findIndex((f) => f.id === fileId);
  if (idx === -1) return;

  const file = state.sharedFiles[idx];
  if (file.storagePath && state.roomUploadedFiles.has(file.storagePath)) {
    deleteFromStorage([file.storagePath]);
    state.roomUploadedFiles.delete(file.storagePath);
  }

  state.sharedFiles.splice(idx, 1);
  state.selectedFileIds.delete(fileId);
  renderFiles(state.sharedFiles);

  const role = getRole();
  const statusEl = role === "computer" ? $("#desktop-file-status") : $("#phone-file-status");
  const expireMsg = `File "${file.originalName}" expired (10m limit) and was deleted`;
  setStatus(statusEl, expireMsg);
  setTimeout(() => {
    if (statusEl && statusEl.textContent === expireMsg) {
      setStatus(statusEl, "");
    }
  }, 4000);
}

export async function initiateBulkDownload(selectedFiles, btnEl) {
  selectedFiles = (selectedFiles || []).filter((f) => !isLockedFile(f));
  if (selectedFiles.length === 0) return;
  try {
    await Promise.all(selectedFiles.map((f) => ensureDecryptedBlob(f)));
  } catch (err) {
    console.warn("Pre-decrypting bulk files warning:", err);
  }
  const isZip = isDesktopComputer() && selectedFiles.length > 1;
  const delayMs = isZip ? 1500 : Math.max(1500, selectedFiles.length * 350);

  if (isZip) {
    await downloadFilesAsZip(selectedFiles, btnEl, triggerFileDownload);
  } else if (selectedFiles.length === 1) {
    triggerFileDownload(selectedFiles[0]);
  } else {
    downloadFilesSequentially(selectedFiles, triggerFileDownload);
  }
  onFileHandedOff(selectedFiles, "downloaded", delayMs);
}

export function updateSelectionUI() {
  const count = state.sharedFiles.length;
  const validIds = new Set(state.sharedFiles.map((f) => f.id));
  for (const id of state.selectedFileIds) {
    if (!validIds.has(id)) state.selectedFileIds.delete(id);
  }

  const selectedCount = state.selectedFileIds.size;
  const allSelected = count > 0 && selectedCount === count;
  const someSelected = selectedCount > 0 && selectedCount < count;

  [$("#desktop-select-all"), $("#phone-select-all")].forEach((cb) => {
    if (cb) {
      cb.checked = allSelected;
      cb.indeterminate = someSelected;
      cb.disabled = count === 0;
    }
  });

  const phoneSelectText = $("#phone-select-all")?.closest("label")?.querySelector(".select-all-text");
  if (phoneSelectText) {
    phoneSelectText.textContent = selectedCount > 0 ? `${selectedCount} selected` : "Select all";
  }

  const selectedFiles = state.sharedFiles.filter((f) => state.selectedFileIds.has(f.id));
  const anyTooLargeToShare = !isDesktopComputer() && selectedFiles.some(isTooLargeToShare);

  // Buttons without a text span are icon-only: label them via aria-label/title
  // so the SVG stays intact.
  const setBtnLabel = (btn, textSelector, label) => {
    const textEl = btn.querySelector(textSelector);
    if (textEl) {
      textEl.textContent = label;
    } else if (btn.classList.contains("bulk-icon-btn")) {
      btn.setAttribute("aria-label", label);
      btn.title = label;
    } else {
      btn.textContent = label;
    }
  };

  [$("#desktop-share-selected"), $("#phone-share-selected")].forEach((btn) => {
    if (btn) {
      btn.disabled = selectedCount === 0;
      // Sharing falls back to download when any selected file is too large,
      // so don't offer Share at all in that case.
      btn.classList.toggle("share-unavailable", anyTooLargeToShare);
      const isComputer = isDesktopComputer();
      const actionName = isComputer ? "Copy" : "Share";
      const label = selectedCount > 0 ? `${actionName} selected (${selectedCount})` : `${actionName} selected`;
      setBtnLabel(btn, ".share-selected-text", label);
    }
  });

  [$("#desktop-download-selected"), $("#phone-download-selected")].forEach((btn) => {
    if (btn) {
      btn.disabled = selectedCount === 0;
      let label = "Download selected";
      if (btn.classList.contains("bulk-primary-btn")) {
        label = "Download";
      } else if (selectedCount > 1 && isDesktopComputer()) {
        label = `Download ZIP (${selectedCount})`;
      } else if (selectedCount > 0) {
        label = `Download selected (${selectedCount})`;
      }
      setBtnLabel(btn, ".download-selected-text", label);
    }
  });

  [$("#desktop-delete-selected"), $("#phone-delete-selected")].forEach((btn) => {
    if (btn) {
      btn.disabled = selectedCount === 0;
      const label = selectedCount > 0 ? `Remove selected (${selectedCount})` : "Remove selected";
      setBtnLabel(btn, ".delete-selected-text", label);
    }
  });

  document.querySelectorAll(".file-checkbox[data-file-id]").forEach((cb) => {
    cb.checked = state.selectedFileIds.has(cb.dataset.fileId);
  });
}

export function handleSelectAll(checked) {
  if (checked) {
    state.sharedFiles.forEach((f) => state.selectedFileIds.add(f.id));
  } else {
    state.selectedFileIds.clear();
  }
  updateSelectionUI();
}

export function handleFileReady(payload, role) {
  const { fileId, originalName, mimeType, size, downloadUrl, storagePath, senderDevice, expiresAt } = payload;
  if (!fileId || !downloadUrl) return;

  if (storagePath) {
    state.roomUploadedFiles.add(storagePath);
  }

  const fileObj = {
    id: fileId,
    originalName,
    mimeType: mimeType || "application/octet-stream",
    size: size || 0,
    downloadUrl,
    storagePath,
    expiresAt: expiresAt || (Date.now() + FILE_TTL_MS),
    senderDevice: senderDevice || (role === "computer" ? "Phone" : "Computer"),
    isEncrypted: Boolean(payload.isEncrypted)
  };

  if (!state.sharedFiles.some((f) => f.id === fileId)) {
    state.sharedFiles.unshift(fileObj);
    renderFiles(state.sharedFiles);
  }

  const peerStatusEl = role === "computer" ? $("#peer-status") : ($("#phone-peer-status") || $("#phone-result"));
  if (peerStatusEl) {
    setStatus(peerStatusEl, `Received "${originalName}" (${formatBytes(size)})`);
  }
}

export function renderFiles(files) {
  const desktopList = $("#received-files-list");
  const desktopCount = $("#received-files-count");
  const desktopSection = $("#received-files-section");

  const phoneList = $("#phone-received-files-list");
  const phoneCount = $("#phone-received-files-count");
  const phoneSection = $("#phone-received-files-section");

  const incomingFiles = Array.from(state.incomingFileTransfers.values());
  const count = files.length;
  const totalCount = count + incomingFiles.length;
  if (desktopCount) desktopCount.textContent = totalCount;
  if (phoneCount) phoneCount.textContent = totalCount;

  if (totalCount > 0) {
    desktopSection?.classList.remove("hidden");
    phoneSection?.classList.remove("hidden");
  } else {
    desktopSection?.classList.add("hidden");
    phoneSection?.classList.add("hidden");
    state.selectedFileIds.clear();
  }

  const phoneTitle = $("#phone-title");
  if (phoneTitle && getRole() === "phone") {
    if (incomingFiles.length > 0) {
      phoneTitle.textContent = "Receiving file…";
    } else if (count > 0) {
      phoneTitle.textContent = "Files ready to download";
    } else {
      phoneTitle.textContent = "Connected to computer";
    }
  }

  if (state.roomId) {
    saveCachedFiles(state.roomId, files);
  }

  const buildItems = (container) => {
    if (!container) return;
    container.innerHTML = "";

    // 1. Render active incoming file transfers
    incomingFiles.forEach((incoming) => {
      const item = document.createElement("div");
      item.className = "file-item file-item-incoming";

      const left = document.createElement("div");
      left.className = "file-item-left";

      const iconBox = document.createElement("div");
      iconBox.className = "file-item-icon-box";
      iconBox.textContent = getFileEmoji(incoming.originalName, incoming.mimeType);
      left.appendChild(iconBox);

      const meta = document.createElement("div");
      meta.className = "file-item-meta";
      const title = document.createElement("p");
      title.className = "file-item-title";
      title.textContent = incoming.originalName;
      title.title = incoming.originalName;

      const sub = document.createElement("p");
      sub.className = "file-item-sub";
      sub.innerHTML = `
        <span>${formatBytes(incoming.size || 0)}</span>
        <span>•</span>
        <span>From ${escapeHtml(incoming.senderDevice || "computer")}</span>
        <span>•</span>
        <span class="pill live-pill incoming-pulse">Receiving…</span>
      `;

      meta.appendChild(title);
      meta.appendChild(sub);
      left.appendChild(meta);
      item.appendChild(left);

      container.appendChild(item);
    });

    // 2. Render completed files
    files.forEach((file) => {
      const item = document.createElement("div");
      item.className = "file-item";
      const isImg = file.mimeType?.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(file.originalName);

      const left = document.createElement("div");
      left.className = "file-item-left";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "file-checkbox";
      checkbox.dataset.fileId = file.id;
      checkbox.checked = state.selectedFileIds.has(file.id);
      checkbox.setAttribute("aria-label", `Select ${file.originalName}`);
      checkbox.addEventListener("change", (e) => {
        if (e.target.checked) {
          state.selectedFileIds.add(file.id);
        } else {
          state.selectedFileIds.delete(file.id);
        }
        updateSelectionUI();
      });
      left.appendChild(checkbox);

      if (isImg && file.downloadUrl) {
        const img = document.createElement("img");
        img.className = "file-item-thumb";
        img.alt = file.originalName;
        if (file.blob instanceof Blob) {
          img.src = URL.createObjectURL(file.blob);
          left.appendChild(img);
        } else if (file.isEncrypted && file.size > AUTO_PREVIEW_MAX_BYTES) {
          const iconBox = document.createElement("div");
          iconBox.className = "file-item-icon-box";
          iconBox.textContent = getFileEmoji(file.originalName, file.mimeType);
          left.appendChild(iconBox);
        } else if (file.isEncrypted) {
          const iconBox = document.createElement("div");
          iconBox.className = "file-item-icon-box";
          iconBox.textContent = getFileEmoji(file.originalName, file.mimeType);
          left.appendChild(iconBox);
          ensureDecryptedBlob(file).then((decBlob) => {
            if (decBlob && iconBox.parentNode) {
              img.src = URL.createObjectURL(decBlob);
              iconBox.replaceWith(img);
            }
          }).catch(() => {});
        } else {
          img.src = file.downloadUrl;
          left.appendChild(img);
        }
      } else {
        const iconBox = document.createElement("div");
        iconBox.className = "file-item-icon-box";
        iconBox.textContent = getFileEmoji(file.originalName, file.mimeType);
        left.appendChild(iconBox);
      }

      const meta = document.createElement("div");
      meta.className = "file-item-meta";
      const title = document.createElement("p");
      title.className = "file-item-title";
      title.textContent = file.originalName;
      title.title = file.originalName;

      const sub = document.createElement("p");
      sub.className = "file-item-sub";
      const remainingSec = Math.max(0, Math.ceil(((file.expiresAt || Date.now()) - Date.now()) / 1000));
      const isSoon = remainingSec <= 60;
      sub.innerHTML = `
        <span>${formatBytes(file.size)}</span>
        <span>•</span>
        <span>${escapeHtml(file.senderDevice || "Shared")}</span>
        ${file.isEncrypted ? `<span>•</span><span class="file-e2ee-tag" title="End-to-end encrypted with zero-knowledge AES-256-GCM">🔒 E2EE</span>` : ""}
        ${!isDesktopComputer() && isTooLargeToShare(file) ? `<span>•</span><span>Too large to share, use Download</span>` : ""}
        ${
          file.expiresAt
            ? `<span>•</span>
               <span class="file-expiry-badge${isSoon ? " expiring-soon" : ""}" data-file-id="${escapeHtml(file.id)}" title="File will be automatically deleted when this timer reaches zero">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                   <circle cx="12" cy="12" r="10"></circle>
                   <polyline points="12 6 12 12 16 14"></polyline>
                 </svg>
                 <span class="file-expiry-time">${formatFileRemaining(file.expiresAt)}</span>
               </span>`
            : ""
        }
      `;

      meta.appendChild(title);
      meta.appendChild(sub);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "file-item-actions";

      const isComputer = isDesktopComputer();
      const canCopy = isCopyableFile(file);
      const tooLargeToShare = !isComputer && isTooLargeToShare(file);
      const showShareOrCopyBtn = !tooLargeToShare && (!isComputer || canCopy);

      let shareBtn = null;
      if (showShareOrCopyBtn) {
        shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.className = isComputer ? "file-share-btn file-copy-btn" : "file-share-btn";
        shareBtn.title = isComputer ? `Copy ${file.originalName}` : `Share ${file.originalName}`;
        shareBtn.innerHTML = isComputer
          ? `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>Copy</span>
        `
          : `
          <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
            <polyline points="16 6 12 2 8 6"></polyline>
            <line x1="12" y1="2" x2="12" y2="15"></line>
          </svg>
          <span>Share</span>
        `;
        shareBtn.addEventListener("click", () => {
          if (isComputer) {
            copySingleFile(file, shareBtn);
          } else {
            shareSingleFile(file);
          }
        });
      }

      const downloadLink = document.createElement("a");
      downloadLink.className = "download-btn";
      let downloadHref = file.downloadUrl;
      if (downloadHref && !downloadHref.startsWith("blob:") && !downloadHref.includes("download=") && !downloadHref.includes("X-Amz-") && !downloadHref.includes("response-content-disposition")) {
        downloadHref += (downloadHref.includes("?") ? "&" : "?") + `download=${encodeURIComponent(file.originalName)}`;
      }
      downloadLink.href = downloadHref;
      downloadLink.download = file.originalName;
      downloadLink.textContent = "Download";
      const showProgress = (written, total) => {
        downloadLink.textContent = `Decrypting ${total ? Math.min(100, Math.floor((written / total) * 100)) : 0}%`;
      };
      downloadLink.addEventListener("click", async (e) => {
        if (file.isEncrypted && !file.blob && file.size > STREAM_TO_DISK_MIN_BYTES && typeof window.showSaveFilePicker === "function") {
          e.preventDefault();
          downloadLink.textContent = "Decrypting…";
          try {
            const streamed = await streamEncryptedToDisk(file, showProgress);
            if (!streamed) {
              await ensureDecryptedBlob(file, showProgress);
              triggerFileDownload(file);
            }
            onFileHandedOff(file, "downloaded", 1500);
          } catch (err) {
            console.error("Failed to decrypt file:", err);
            alert("Could not decrypt file. Please verify room encryption key.");
          } finally {
            downloadLink.textContent = "Download";
          }
        } else if (file.isEncrypted && !file.blob) {
          e.preventDefault();
          downloadLink.textContent = "Decrypting…";
          try {
            await ensureDecryptedBlob(file, showProgress);
            triggerFileDownload(file);
            onFileHandedOff(file, "downloaded", 1500);
          } catch (err) {
            console.error("Failed to decrypt file:", err);
            alert("Could not decrypt file. Please verify room encryption key.");
          } finally {
            downloadLink.textContent = "Download";
          }
        } else if (file.blob instanceof Blob) {
          e.preventDefault();
          triggerFileDownload(file);
          onFileHandedOff(file, "downloaded", 1500);
        } else {
          onFileHandedOff(file, "downloaded", 1500);
        }
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "file-remove-btn";
      removeBtn.title = `Remove ${file.originalName}`;
      removeBtn.setAttribute("aria-label", `Remove ${file.originalName}`);
      removeBtn.innerHTML = `
        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <line x1="10" y1="11" x2="10" y2="17"></line>
          <line x1="14" y1="11" x2="14" y2="17"></line>
        </svg>
        <span>Remove</span>
      `;
      removeBtn.addEventListener("click", () => {
        removeSharedFiles(file);
      });

      if (shareBtn) actions.appendChild(shareBtn);
      actions.appendChild(downloadLink);
      actions.appendChild(removeBtn);

      item.appendChild(left);
      item.appendChild(actions);
      container.appendChild(item);
    });
  };

  buildItems(desktopList);
  buildItems(phoneList);
  updateSelectionUI();

  if (totalCount > 0) {
    const role = getRole();
    const activeSection = role === "phone" ? phoneSection : desktopSection;
    if (activeSection && !activeSection.classList.contains("hidden")) {
      activeSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}
