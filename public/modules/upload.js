import { supabase } from "./supabaseClient.js";
import {
  MAX_FILE_SIZE,
  MAX_SHARE_FILE_SIZE,
  FILE_TTL_MS,
  MAX_PARALLEL_UPLOADS
} from "./constants.js";
import { state } from "./state.js";
import { formatBytes, getFileEmoji, setStatus, generateSecureToken } from "./dom.js";
import { renderFiles } from "./fileManager.js";
import { recordDiagnostic, logErrorToSupabase, copyDiagnostics } from "./diagnostics.js";
import { isHeicFile, convertHeicToJpeg } from "./heicConverter.js";
import { encryptFile } from "./crypto.js";
import { createChunkedEncryptor, CHUNK_SIZE } from "./chunkedCrypto.js";
import { allPeersSupport, anyIosPeerLacks, otherPeers } from "./peers.js";
import { acquireWakeLock, releaseWakeLock } from "./wakeLock.js";
import { logFileTransfer } from "./usage.js";

const SINGLE_SHOT_E2EE_MAX = 100 * 1024 * 1024; // legacy whole-file encryption (old peers)
const PART_CONCURRENCY = 3;
const PART_RETRY_DELAYS_MS = [1000, 3000, 8000];

/**
 * Chunked end-to-end encryption (any size, constant memory) is used when:
 *  - the room has an encryption key and the file is bigger than one chunk,
 *  - every connected device advertises support for it (older open tabs can't read it), and
 *  - no receiving iPhone would have to decrypt more than MAX_SHARE_FILE_SIZE in memory: iPhones that can
 *    decrypt into on-device storage advertise it and take any size (tested to 1 GB on iPhone 17).
 * With no peer connected yet, very large files keep the previous behaviour, since the receiver is unknown.
 */
function shouldUseChunkedEncryption(file) {
  if (!state.cryptoKey || file.size <= CHUNK_SIZE) return false;
  if (!allPeersSupport("e2ee-chunked-1")) return false;
  if (file.size > MAX_SHARE_FILE_SIZE && (anyIosPeerLacks("e2ee-disk-decrypt-1") || otherPeers().length === 0)) return false;
  return true;
}

// Right after pairing, presence (which carries the peers' capabilities) can lag a moment behind
async function waitForPeerPresence(timeoutMs = 3000) {
  const start = Date.now();
  while (otherPeers().length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function uploadFileToR2(args) {
  if (state.cryptoKey && args.file.size > CHUNK_SIZE && otherPeers().length === 0) await waitForPeerPresence();
  if (shouldUseChunkedEncryption(args.file)) return uploadChunkedEncrypted(args);
  return uploadSingleShot(args);
}

async function signApi(body) {
  const { data, error } = await supabase.functions.invoke("r2-sign", { body });
  if (error || !data?.success) throw new Error(data?.error || error?.message || "Upload service error");
  return data;
}

// PUT one encrypted part. The response is always read to the end: a fetch whose response is never
// consumed keeps its request body alive (measured: ~2x the file size held in Chrome after a 300 MB upload).
async function putPart(url, bytes, signal) {
  const res = await fetch(url, { method: "PUT", body: bytes, signal });
  await res.arrayBuffer().catch(() => {});
  if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
}

async function uploadChunkedEncrypted({ file, fileId, targetRoomId, onProgress, abortSignal }) {
  const abortedError = () => {
    const err = new Error("Upload aborted");
    err.name = "AbortError";
    return err;
  };
  if (abortSignal?.aborted) throw abortedError();

  const encryptor = createChunkedEncryptor(file, state.cryptoKey);
  const created = await signApi({
    action: "multipart-create",
    roomId: targetRoomId,
    fileId,
    fileSize: encryptor.encryptedSize,
  });
  const { uploadId, storagePath, downloadUrl } = created;

  const abortController = new AbortController();
  const loadedByPart = new Map();
  const reportProgress = () => {
    let loaded = 0;
    for (const n of loadedByPart.values()) loaded += n;
    if (typeof onProgress === "function") onProgress(Math.min(loaded, encryptor.encryptedSize), encryptor.encryptedSize);
  };
  const onAbort = () => abortController.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  // Presigned part URLs, fetched in batches as workers need them
  const urls = new Map();
  let signing = null;
  async function urlFor(index) {
    while (!urls.has(index + 1)) {
      if (!signing) {
        const partNumbers = [];
        for (let n = index + 1; n <= encryptor.count && partNumbers.length < 20; n++) if (!urls.has(n)) partNumbers.push(n);
        signing = signApi({ action: "multipart-sign-parts", roomId: targetRoomId, storagePath, uploadId, partNumbers })
          .then(({ urls: signed }) => Object.entries(signed).forEach(([n, url]) => urls.set(Number(n), url)))
          .finally(() => (signing = null));
      }
      await signing;
    }
    return urls.get(index + 1);
  }

  async function uploadPart(index) {
    for (let attempt = 0; ; attempt++) {
      if (abortSignal?.aborted) throw abortedError();
      try {
        const bytes = await encryptor.encryptPart(index);
        await putPart(await urlFor(index), bytes, abortController.signal);
        loadedByPart.set(index, bytes.byteLength);
        reportProgress();
        return;
      } catch (err) {
        loadedByPart.delete(index);
        reportProgress();
        if (err.name === "AbortError" || abortSignal?.aborted || attempt >= PART_RETRY_DELAYS_MS.length) throw err;
        await new Promise((r) => setTimeout(r, PART_RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  try {
    const queue = Array.from({ length: encryptor.count }, (_, i) => i);
    let failed = false;
    await Promise.all(
      Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !failed) {
          try {
            await uploadPart(queue.shift());
          } catch (err) {
            failed = true;
            throw err;
          }
        }
      })
    );
    await signApi({ action: "multipart-complete", roomId: targetRoomId, storagePath, uploadId, partCount: encryptor.count });
  } catch (err) {
    signApi({ action: "multipart-abort", roomId: targetRoomId, storagePath, uploadId }).catch(() => {});
    if (abortSignal?.aborted) throw abortedError();
    logErrorToSupabase("upload_chunked_error", err, { fileSize: file.size });
    throw err;
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
  }

  state.roomUploadedFiles.add(storagePath);
  recordDiagnostic("upload", `Uploaded ${file.name}`, { size: file.size, isEncrypted: true, chunked: true });
  return { downloadUrl, storagePath, isEncrypted: true };
}

function uploadSingleShot({ file, fileId, targetRoomId, onProgress, abortSignal }) {
  return new Promise(async (resolve, reject) => {
    let xhr = null;
    let isAborted = false;
    let storagePath = null;

    const cleanupStorage = async () => {
      if (!storagePath) return;
      try {
        await supabase.functions.invoke("r2-sign", {
          body: { action: "delete", roomId: targetRoomId, paths: [storagePath] }
        });
        state.roomUploadedFiles.delete(storagePath);
      } catch (err) {
        console.warn("Failed to delete cancelled upload from R2:", err);
      }
    };

    const handleAbort = async () => {
      if (isAborted) return;
      isAborted = true;
      if (xhr) {
        try { xhr.abort(); } catch (_) {}
      }
      await cleanupStorage();
      const err = new Error("Upload aborted");
      err.name = "AbortError";
      reject(err);
    };

    if (abortSignal?.aborted) {
      const err = new Error("Upload aborted");
      err.name = "AbortError";
      return reject(err);
    }

    if (abortSignal) {
      abortSignal.addEventListener("abort", handleAbort, { once: true });
    }

    try {
      // Check if eligible for Phase 1 E2EE: under 100 MB and crypto key available
      const shouldEncrypt = Boolean(state.cryptoKey && file.size <= SINGLE_SHOT_E2EE_MAX);
      let payloadToSend = file;
      let isEncrypted = false;

      if (shouldEncrypt) {
        try {
          const encResult = await encryptFile(file, state.cryptoKey);
          payloadToSend = encResult.data;
          isEncrypted = encResult.isEncrypted;
        } catch (encErr) {
          console.warn("File encryption failed, falling back to direct upload:", encErr);
          payloadToSend = file;
          isEncrypted = false;
        }
      }

      // 1. Request presigned R2 upload and download URLs from Edge Function
      const { data: signData, error: signError } = await supabase.functions.invoke("r2-sign", {
        body: {
          action: "upload",
          roomId: targetRoomId,
          // Encrypted files are named by the receiver after decrypting; only the
          // unencrypted fallback needs the name for a direct download.
          ...(isEncrypted ? {} : { fileName: file.name }),
          fileId,
          mimeType: isEncrypted ? "application/octet-stream" : (file.type || "application/octet-stream"),
          fileSize: payloadToSend.size
        }
      });

      if (signError || !signData?.uploadUrl) {
        throw new Error(signError?.message || signData?.error || "Failed to get R2 upload URL");
      }

      storagePath = signData.storagePath;

      if (isAborted || abortSignal?.aborted) {
        await cleanupStorage();
        const err = new Error("Upload aborted");
        err.name = "AbortError";
        return reject(err);
      }

      // 2. Stream directly to Cloudflare R2 via XMLHttpRequest with progress tracking
      xhr = new XMLHttpRequest();
      xhr.open("PUT", signData.uploadUrl, true);
      xhr.setRequestHeader("Content-Type", isEncrypted ? "application/octet-stream" : (file.type || "application/octet-stream"));

      xhr.upload.onprogress = (evt) => {
        if (isAborted || abortSignal?.aborted) return;
        if (evt.lengthComputable && typeof onProgress === "function") {
          onProgress(evt.loaded, evt.total);
        }
      };

      xhr.onload = () => {
        if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
        if (isAborted || abortSignal?.aborted) {
          cleanupStorage();
          const err = new Error("Upload aborted");
          err.name = "AbortError";
          return reject(err);
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          state.roomUploadedFiles.add(storagePath);
          recordDiagnostic("upload", `Uploaded ${file.name}`, { size: file.size, isEncrypted });
          resolve({ downloadUrl: signData.downloadUrl, storagePath, isEncrypted });
        } else {
          console.error("R2 PUT error:", xhr.status, xhr.responseText);
          logErrorToSupabase("upload_r2_error", new Error(`R2 upload status ${xhr.status}`), {
            fileSize: file.size
          });
          cleanupStorage();
          reject(new Error(`Storage upload failed (${xhr.status})`));
        }
      };

      xhr.onerror = () => {
        if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
        if (isAborted || abortSignal?.aborted) {
          cleanupStorage();
          const err = new Error("Upload aborted");
          err.name = "AbortError";
          return reject(err);
        }
        cleanupStorage();
        reject(new Error("Network error during file upload to storage"));
      };

      xhr.send(payloadToSend);
    } catch (err) {
      if (abortSignal) abortSignal.removeEventListener("abort", handleAbort);
      if (isAborted || abortSignal?.aborted) {
        const aErr = new Error("Upload aborted");
        aErr.name = "AbortError";
        return reject(aErr);
      }
      reject(err);
    }
  });
}

export async function cleanupRoomStorage(targetRoomId) {
  if (!targetRoomId) return;

  try {
    await supabase.functions.invoke("r2-sign", {
      body: { action: "delete-room", roomId: targetRoomId }
    });
    Array.from(state.roomUploadedFiles)
      .filter((path) => path.startsWith(`${targetRoomId}/`))
      .forEach((f) => state.roomUploadedFiles.delete(f));
  } catch (err) {
    console.warn("Storage cleanup error:", err);
  }
}

export function setupFileUpload({
  dropzoneEl,
  inputEl,
  previewListEl,
  sendBtn,
  statusEl,
  senderDevice = "Computer",
  progressContainerEl = null,
  progressBarEl = null,
  progressTextEl = null,
  cancelBtnEl = null,
  shouldConvertHeic = () => false
}) {
  let stagedFiles = [];
  let isUploading = false;
  let currentTargetDeviceName = "other device";
  let holdsWakeLock = false;

  function holdScreenAwake() {
    if (holdsWakeLock) return;
    holdsWakeLock = true;
    acquireWakeLock();
  }

  function letScreenSleep() {
    if (!holdsWakeLock) return;
    holdsWakeLock = false;
    releaseWakeLock();
  }

  // State map: file -> { fileId, originalName, mimeType, size, abortController, bytesUploaded, percent }
  const activeUploads = new Map();
  const chipBadgeMap = new Map();
  const failedFiles = new Set();

  let completedBatchBytes = 0;
  let completedCount = 0;
  let failedCount = 0;
  let cancelledCount = 0;

  function renderStagedFiles() {
    previewListEl.innerHTML = "";
    chipBadgeMap.clear();

    if (stagedFiles.length === 0) {
      previewListEl.classList.add("hidden");
      sendBtn.classList.add("hidden");
      return;
    }

    previewListEl.classList.remove("hidden");

    // 1. Batch header summary
    const totalBytes = stagedFiles.reduce((acc, f) => acc + f.size, 0);
    const summaryRow = document.createElement("div");
    summaryRow.className = "staged-summary";

    const countLabel = document.createElement("span");
    countLabel.className = "staged-summary-count";
    countLabel.textContent = `${stagedFiles.length} file${stagedFiles.length > 1 ? "s" : ""} selected • ${formatBytes(totalBytes)}`;
    summaryRow.appendChild(countLabel);

    // Only show "Clear all" when not actively uploading (while uploading, cancel is on the progress bar)
    if (!isUploading) {
      const clearAllBtn = document.createElement("button");
      clearAllBtn.type = "button";
      clearAllBtn.className = "link-btn-danger";
      clearAllBtn.textContent = "Clear all";
      clearAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearSelected();
        setStatus(statusEl, "");
      });
      summaryRow.appendChild(clearAllBtn);
    }

    previewListEl.appendChild(summaryRow);

    // 2. File list chips
    const chipsContainer = document.createElement("div");
    chipsContainer.className = "staged-chips-container";

    stagedFiles.forEach((file) => {
      const chip = document.createElement("div");
      chip.className = "file-chip";

      const activeEntry = activeUploads.get(file);
      const isCurrentlyUploading = Boolean(activeEntry);
      if (isCurrentlyUploading) {
        chip.classList.add("uploading");
      }

      const info = document.createElement("div");
      info.className = "file-chip-info";

      const icon = document.createElement("span");
      icon.className = "file-badge-icon";
      icon.textContent = getFileEmoji(file.name, file.type);

      const details = document.createElement("div");
      details.className = "file-chip-details";

      const nameRow = document.createElement("div");
      nameRow.className = "file-chip-title-row";

      const name = document.createElement("p");
      name.className = "file-name";
      name.textContent = file.name;
      name.title = file.name;
      nameRow.appendChild(name);

      if (failedFiles.has(file)) {
        const badge = document.createElement("span");
        badge.className = "file-chip-badge error";
        badge.textContent = "failed";
        nameRow.appendChild(badge);
      } else if (isUploading) {
        const badge = document.createElement("span");
        badge.className = "file-chip-badge";
        if (isCurrentlyUploading) {
          badge.textContent = `${activeEntry.percent || 0}%`;
        } else {
          badge.textContent = "queued";
        }
        nameRow.appendChild(badge);
        chipBadgeMap.set(file, badge);
      }

      const size = document.createElement("p");
      size.className = "file-size";
      size.textContent = formatBytes(file.size);

      details.appendChild(nameRow);
      details.appendChild(size);
      info.appendChild(icon);
      info.appendChild(details);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "icon-button";
      removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const fileToRemove = file;
        const fileIdx = stagedFiles.indexOf(fileToRemove);
        if (fileIdx !== -1) {
          stagedFiles.splice(fileIdx, 1);
        }

        if (failedFiles.has(fileToRemove)) {
          failedFiles.delete(fileToRemove);
        }

        if (activeUploads.has(fileToRemove)) {
          const entry = activeUploads.get(fileToRemove);
          try {
            entry.abortController.abort();
          } catch (_) {}
          try {
            state.channel?.send({
              type: "broadcast",
              event: "file:upload_cancelled",
              payload: {
                fileId: entry.fileId,
                originalName: entry.originalName,
                senderDevice
              }
            });
          } catch (_) {}
          activeUploads.delete(fileToRemove);
        }

        renderStagedFiles();

        if (stagedFiles.length === 0) {
          isUploading = false;
          letScreenSleep();
          dropzoneEl.classList.remove("disabled");
          dropzoneEl.classList.remove("is-uploading");
          progressContainerEl?.classList.add("hidden");
          setStatus(statusEl, "");
        } else if (isUploading) {
          spawnWorkers();
        }
      });

      chip.appendChild(info);
      chip.appendChild(removeBtn);
      chipsContainer.appendChild(chip);
    });

    previewListEl.appendChild(chipsContainer);
    sendBtn.classList.add("hidden");
  }

  async function addFiles(fileList) {
    if (state.isMaintenanceActive) {
      alert("Handoff is currently undergoing maintenance. Transfers are temporarily paused.");
      return;
    }
    if (!fileList || fileList.length === 0) return;

    let filesToProcess = Array.from(fileList);

    // Auto-convert HEIC photos to JPG for Windows computers
    if (shouldConvertHeic()) {
      const heicFiles = filesToProcess.filter((f) => isHeicFile(f));
      if (heicFiles.length > 0) {
        const convertingMsg =
          heicFiles.length === 1
            ? "Optimizing photo for Windows…"
            : `Optimizing ${heicFiles.length} photos for Windows…`;
        setStatus(statusEl, convertingMsg);

        const convertedList = [];
        let convertedSuccessCount = 0;

        for (const file of filesToProcess) {
          if (isHeicFile(file)) {
            try {
              const convertedFile = await convertHeicToJpeg(file);
              convertedList.push(convertedFile);
              if (convertedFile !== file) {
                convertedSuccessCount++;
              }
            } catch (err) {
              console.warn("Failed to convert HEIC file:", file.name, err);
              convertedList.push(file);
            }
          } else {
            convertedList.push(file);
          }
        }

        filesToProcess = convertedList;
        if (convertedSuccessCount > 0) {
          recordDiagnostic(
            "upload",
            `Auto-converted ${convertedSuccessCount} HEIC photo(s) to JPG for Windows`
          );
        }
      }
    }

    let oversizedCount = 0;
    filesToProcess.forEach((file) => {
      if (file.size > MAX_FILE_SIZE) {
        oversizedCount++;
        return;
      }
      const isDup = stagedFiles.some(
        (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
      );
      if (!isDup) {
        stagedFiles.push(file);
      }
    });

    if (oversizedCount > 0) {
      setStatus(statusEl, `File${oversizedCount > 1 ? "s" : ""} exceed 1.5 GB maximum transfer size.`);
    } else {
      setStatus(statusEl, "");
    }
    renderStagedFiles();

    if (!isUploading) {
      startUpload();
    } else {
      spawnWorkers();
      updateBatchProgress();
    }
  }

  function clearSelected() {
    const wasBusy = isUploading;
    isUploading = false;
    letScreenSleep();

    // Abort all in-flight uploads
    for (const [file, entry] of activeUploads.entries()) {
      try {
        entry.abortController.abort();
      } catch (_) {}
      try {
        state.channel?.send({
          type: "broadcast",
          event: "file:upload_cancelled",
          payload: {
            fileId: entry.fileId,
            originalName: entry.originalName,
            senderDevice
          }
        });
      } catch (_) {}
    }

    activeUploads.clear();
    chipBadgeMap.clear();
    failedFiles.clear();
    stagedFiles = [];

    renderStagedFiles();

    dropzoneEl.classList.remove("disabled");
    dropzoneEl.classList.remove("is-uploading");
    progressContainerEl?.classList.add("hidden");
    if (progressBarEl) progressBarEl.style.width = "0%";
    if (progressTextEl) progressTextEl.textContent = "";

    if (wasBusy) {
      setStatus(statusEl, "Upload cancelled.");
    }
  }

  function getNextQueuedFile() {
    return stagedFiles.find((f) => !activeUploads.has(f) && !failedFiles.has(f)) || null;
  }

  function updateBatchProgress() {
    const totalBytes = stagedFiles.reduce((acc, f) => acc + f.size, 0);
    if (totalBytes === 0) return;

    let currentActiveBytes = 0;
    for (const entry of activeUploads.values()) {
      currentActiveBytes += entry.bytesUploaded;
    }

    const currentTotalBytes = Math.min(totalBytes, completedBatchBytes + currentActiveBytes);
    const percent = Math.min(100, Math.round((currentTotalBytes / totalBytes) * 100));

    if (progressBarEl) {
      progressBarEl.style.width = `${percent}%`;
    }

    if (progressTextEl) {
      const activeCount = activeUploads.size;
      const totalCount = completedCount + stagedFiles.length;

      if (totalCount <= 1) {
        const singleFile = activeUploads.keys().next().value || stagedFiles[0];
        progressTextEl.textContent = singleFile
          ? `Uploading ${singleFile.name} (${percent}%)`
          : `Uploading (${percent}%)`;
      } else {
        progressTextEl.textContent = activeCount > 1
          ? `Uploading ${activeCount} files in parallel (${percent}%)`
          : `Uploading (${completedCount + 1}/${totalCount}): ${percent}%`;
      }
    }
  }

  function spawnWorkers() {
    if (!isUploading) return;
    const availableSlots = MAX_PARALLEL_UPLOADS - activeUploads.size;
    for (let i = 0; i < availableSlots; i++) {
      if (getNextQueuedFile() !== null) {
        runUploadWorker();
      } else {
        break;
      }
    }
  }

  async function runUploadWorker() {
    while (isUploading) {
      const fileToUpload = getNextQueuedFile();
      if (!fileToUpload) break;

      const fileId = `${Date.now()}-${generateSecureToken(8)}`;
      const originalName = fileToUpload.name;
      const mimeType = fileToUpload.type || "application/octet-stream";
      const size = fileToUpload.size;
      const abortController = new AbortController();

      const uploadEntry = {
        fileId,
        originalName,
        mimeType,
        size,
        abortController,
        bytesUploaded: 0,
        percent: 0
      };

      activeUploads.set(fileToUpload, uploadEntry);
      renderStagedFiles();
      updateBatchProgress();

      let uploadResult = null;
      let wasCancelled = false;
      let failed = false;

      try {
        state.channel.send({
          type: "broadcast",
          event: "file:upload_started",
          payload: {
            fileId,
            originalName,
            mimeType,
            size,
            senderDevice
          }
        });

        uploadResult = await uploadFileToR2({
          file: fileToUpload,
          fileId,
          targetRoomId: state.roomId,
          abortSignal: abortController.signal,
          onProgress: (bytesUploaded, bytesTotal) => {
            if (abortController.signal.aborted) return;
            uploadEntry.bytesUploaded = bytesUploaded;
            uploadEntry.percent = bytesTotal > 0 ? Math.min(100, Math.round((bytesUploaded / bytesTotal) * 100)) : 0;
            updateBatchProgress();
            const badge = chipBadgeMap.get(fileToUpload);
            if (badge) {
              badge.textContent = `${uploadEntry.percent}%`;
            }
          }
        });

        if (abortController.signal.aborted || !stagedFiles.includes(fileToUpload)) {
          wasCancelled = true;
          cancelledCount++;
        } else {
          const fileExpiresAt = Date.now() + FILE_TTL_MS;

          await state.channel.send({
            type: "broadcast",
            event: "file:ready",
            payload: {
              fileId,
              originalName,
              mimeType,
              size,
              downloadUrl: uploadResult.downloadUrl,
              storagePath: uploadResult.storagePath,
              senderDevice,
              expiresAt: fileExpiresAt,
              isEncrypted: Boolean(uploadResult.isEncrypted)
            }
          });

          // Add sent file to local sharedFiles list
          if (!state.sharedFiles.some((f) => f.id === fileId)) {
            state.sharedFiles.unshift({
              id: fileId,
              originalName,
              mimeType,
              size,
              downloadUrl: uploadResult.downloadUrl,
              storagePath: uploadResult.storagePath,
              blob: fileToUpload,
              senderDevice,
              expiresAt: fileExpiresAt,
              isEncrypted: Boolean(uploadResult.isEncrypted)
            });
            renderFiles(state.sharedFiles);
          }

          completedCount++;
          completedBatchBytes += size;
        }
      } catch (err) {
        if (err.name === "AbortError" || abortController.signal.aborted) {
          wasCancelled = true;
          cancelledCount++;
          try {
            state.channel.send({
              type: "broadcast",
              event: "file:upload_cancelled",
              payload: {
                fileId,
                originalName,
                senderDevice
              }
            });
          } catch (_) {}
        } else {
          console.error(`Upload of ${originalName} failed:`, err);
          logErrorToSupabase("upload_file_failed", err, {
            fileSize: size
          });
          failed = true;
          failedCount++;
          failedFiles.add(fileToUpload);
          const badge = chipBadgeMap.get(fileToUpload);
          if (badge) {
            badge.textContent = "failed";
            badge.className = "file-chip-badge error";
          }
        }
      } finally {
        activeUploads.delete(fileToUpload);
        logFileTransfer({
          role: state.currentRole,
          peers: otherPeers(),
          size,
          outcome: wasCancelled ? "cancelled" : failed ? "failed" : "ok"
        });

        if (!wasCancelled && !failedFiles.has(fileToUpload)) {
          const idx = stagedFiles.indexOf(fileToUpload);
          if (idx !== -1) stagedFiles.splice(idx, 1);
        }

        renderStagedFiles();
        updateBatchProgress();
      }
    }

    // Check if entire batch is complete
    if (activeUploads.size === 0 && (getNextQueuedFile() === null || stagedFiles.length === 0)) {
      isUploading = false;
      letScreenSleep();
      dropzoneEl.classList.remove("disabled");
      dropzoneEl.classList.remove("is-uploading");
      progressContainerEl?.classList.add("hidden");

      if (completedCount > 0) {
        recordDiagnostic("upload", `Batch upload completed (${completedCount} sent)`);
        const sentMsg = completedCount === 1
          ? `Sent 1 file to ${currentTargetDeviceName}.`
          : `Sent ${completedCount} files to ${currentTargetDeviceName}.`;
        setStatus(
          statusEl,
          cancelledCount > 0 ? `${sentMsg} Cancelled remaining.` : sentMsg
        );
      } else if (cancelledCount > 0 && failedCount === 0) {
        setStatus(statusEl, "Upload cancelled.");
      } else if (failedCount > 0) {
        if (statusEl) {
          statusEl.innerHTML = `File transfer failed. <button type="button" class="diagnostics-link" id="${statusEl.id}-diag-btn">Copy diagnostics</button>`;
          const diagBtn = document.getElementById(`${statusEl.id}-diag-btn`);
          if (diagBtn) {
            diagBtn.addEventListener("click", async () => {
              const res = await copyDiagnostics();
              diagBtn.textContent = res.success ? "✓ Copied!" : "✓ Report generated!";
              setTimeout(() => {
                diagBtn.textContent = "Copy diagnostics";
              }, 2500);
            });
          }
        }
        sendBtn.textContent = "Retry upload";
        sendBtn.disabled = false;
        sendBtn.classList.remove("hidden");
      }
    }
  }

  async function startUpload() {
    if (state.isMaintenanceActive) {
      alert("Handoff is currently undergoing maintenance. Transfers are temporarily paused.");
      return;
    }
    if (isUploading) return;
    if (!stagedFiles.length || !state.roomId || !state.channel) return;

    recordDiagnostic("upload", "Batch upload started", {
      fileCount: stagedFiles.length,
      totalBytes: stagedFiles.reduce((acc, f) => acc + f.size, 0)
    });

    isUploading = true;
    holdScreenAwake();
    completedBatchBytes = 0;
    completedCount = 0;
    failedCount = 0;
    cancelledCount = 0;
    failedFiles.clear();

    sendBtn.classList.add("hidden");
    dropzoneEl.classList.remove("disabled");
    dropzoneEl.classList.add("is-uploading");
    progressContainerEl?.classList.remove("hidden");
    if (progressBarEl) progressBarEl.style.width = "0%";
    if (progressTextEl) progressTextEl.textContent = "Preparing files…";
    setStatus(statusEl, "");

    spawnWorkers();
  }

  inputEl.addEventListener("change", () => {
    if (inputEl.files?.length) {
      addFiles(inputEl.files);
      inputEl.value = "";
    }
  });

  dropzoneEl.addEventListener("click", () => inputEl.click());
  dropzoneEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputEl.click();
    }
  });

  dropzoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzoneEl.classList.add("dragover");
  });

  dropzoneEl.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove("dragover");
  });

  dropzoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove("dragover");
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files);
    }
  });

  sendBtn.addEventListener("click", () => {
    startUpload();
  });

  cancelBtnEl?.addEventListener("click", () => {
    clearSelected();
  });

  return {
    addFiles,
    startUpload,
    clearSelected,
    cancelUpload: clearSelected,
    getStagedFiles: () => stagedFiles,
    setTargetDeviceName: (name) => {
      currentTargetDeviceName = name;
    }
  };
}
