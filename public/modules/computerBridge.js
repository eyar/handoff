// Computer-to-Computer Bridge module
// Uses the phone's camera to scan Computer 2's QR code and bridge them together

import { state } from "./state.js";
import { supabase } from "./supabaseClient.js";
import { $, setStatus } from "./dom.js";
import jsQR from "../vendor/jsqr/jsQR.mjs";
import { resetToHome } from "./realtime.js";

let videoStream = null;
let scanAnimationFrame = null;
let barcodeDetector = null;
let isScanning = false;
let isBridgeProcessing = false;
let currentFacingMode = "environment";
let availableVideoDevices = [];
let currentDeviceIndex = 0;
// Bumped by stopCamera() so an in-flight startCamera() knows it was superseded
let cameraGeneration = 0;

// Initialize native BarcodeDetector if available
if (typeof window !== "undefined" && "BarcodeDetector" in window) {
  try {
    barcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
  } catch (e) {
    barcodeDetector = null;
  }
}

export function initComputerBridge() {
  const startBtn = $("#start-bridge-scanner-btn");
  const closeBtn = $("#close-scanner-btn");
  const switchBtn = $("#switch-camera-btn");
  const doneBtn = $("#bridge-done-btn");
  const scannerModal = $("#qr-scanner-modal");
  const successModal = $("#bridge-success-modal");

  startBtn?.addEventListener("click", () => {
    openBridgeScanner();
  });

  closeBtn?.addEventListener("click", () => {
    closeBridgeScanner();
  });

  switchBtn?.addEventListener("click", () => {
    switchCamera();
  });

  doneBtn?.addEventListener("click", () => {
    finishPhoneHandoff();
  });

  // Tap backdrop outside the card to dismiss scanner
  scannerModal?.addEventListener("click", (e) => {
    if (e.target === scannerModal) {
      closeBridgeScanner();
    }
  });

  // Tap backdrop outside success card to dismiss
  successModal?.addEventListener("click", (e) => {
    if (e.target === successModal) {
      finishPhoneHandoff();
    }
  });

  // Handle Android back button / mobile swipe-back gesture
  window.addEventListener("popstate", () => {
    if (isScanning && !scannerModal?.classList.contains("hidden")) {
      closeBridgeScanner(false);
    }
  });
}

let customScanHandler = null;
let currentScannerModalTrigger = null;

export async function openBridgeScanner() {
  if (!state.roomId) return;

  const modal = $("#qr-scanner-modal");
  const titleEl = $("#scanner-modal-title");
  const statusEl = $("#scanner-status");
  const closeBtn = $("#close-scanner-btn");

  if (titleEl) titleEl.textContent = "Scan Computer 2";
  if (statusEl) statusEl.textContent = "Point camera at Computer 2’s screen…";

  customScanHandler = null;
  currentScannerModalTrigger = "#start-bridge-scanner-btn";

  currentFacingMode = "environment";
  currentDeviceIndex = 0;

  // Push history state so Android back button / swipe back gesture closes scanner
  try {
    history.pushState({ modal: "bridge-scanner" }, "");
  } catch (_) {}

  modal?.classList.remove("hidden");
  closeBtn?.focus();

  isScanning = true;
  isBridgeProcessing = false;

  await startCamera();
}

export async function openPairingScanner({
  title = "Scan Computer Screen",
  statusText = "Point camera at your PC screen’s QR code…",
  triggerBtn = "#staged-scan-camera-btn",
  onScan
} = {}) {
  const modal = $("#qr-scanner-modal");
  const titleEl = $("#scanner-modal-title");
  const statusEl = $("#scanner-status");
  const closeBtn = $("#close-scanner-btn");

  if (titleEl) titleEl.textContent = title;
  if (statusEl) statusEl.textContent = statusText;

  customScanHandler = onScan;
  currentScannerModalTrigger = triggerBtn;

  currentFacingMode = "environment";
  currentDeviceIndex = 0;

  try {
    history.pushState({ modal: "qr-scanner" }, "");
  } catch (_) {}

  modal?.classList.remove("hidden");
  closeBtn?.focus();

  isScanning = true;
  isBridgeProcessing = false;

  await startCamera();
}

export function closeBridgeScanner(triggerHistoryBack = true) {
  isScanning = false;
  stopCamera();
  const modal = $("#qr-scanner-modal");
  modal?.classList.add("hidden");

  // Re-focus the open button for screen readers
  if (currentScannerModalTrigger) {
    $(currentScannerModalTrigger)?.focus();
  }

  if (triggerHistoryBack && (history.state?.modal === "bridge-scanner" || history.state?.modal === "qr-scanner")) {
    try {
      history.back();
    } catch (_) {}
  }
}

export async function switchCamera() {
  if (availableVideoDevices.length > 1) {
    currentDeviceIndex = (currentDeviceIndex + 1) % availableVideoDevices.length;
    const nextDevice = availableVideoDevices[currentDeviceIndex];
    const track = videoStream?.getVideoTracks()?.[0];
    const currentId = track?.getSettings?.()?.deviceId;
    if (nextDevice.deviceId === currentId && availableVideoDevices.length > 1) {
      currentDeviceIndex = (currentDeviceIndex + 1) % availableVideoDevices.length;
    }
    await startCamera(availableVideoDevices[currentDeviceIndex].deviceId);
  } else {
    currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    await startCamera();
  }
}

async function startCamera(preferDeviceId = null) {
  const video = $("#qr-scanner-video");
  const statusEl = $("#scanner-status");
  if (!video) return;

  stopCamera();
  const generation = cameraGeneration;
  const isStale = () => generation !== cameraGeneration || !isScanning;

  let stream = null;

  // 1. If explicit device ID passed (e.g. from user tapping switch camera)
  if (preferDeviceId) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: preferDeviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (e) {
      console.warn("Failed to open specific camera deviceId:", e);
    }
  }

  // 2. If wanting back camera and devices are already enumerated with labels
  if (!stream && currentFacingMode === "environment") {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      if (videoDevices.length > 0 && videoDevices.some((d) => Boolean(d.label))) {
        availableVideoDevices = videoDevices;
        const backCamera = videoDevices.find((d) => {
          const lbl = (d.label || "").toLowerCase();
          return lbl.includes("back") || lbl.includes("rear") || lbl.includes("environment") || lbl.includes("facing back");
        });
        if (backCamera) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                deviceId: { exact: backCamera.deviceId },
                width: { ideal: 1280 },
                height: { ideal: 720 }
              },
              audio: false
            });
          } catch (e) {
            console.warn("Failed to open backCamera by deviceId:", e);
          }
        }
      }
    } catch (_) {}
  }

  // 3. Try exact environment facingMode (forces the rear camera on mobile browsers)
  if (!stream && currentFacingMode === "environment") {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (err) {
      console.warn("facingMode exact:environment not supported, falling back:", err);
    }
  }

  // 4. Try standard environment facingMode
  if (!stream && currentFacingMode === "environment") {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (err) {
      console.warn("facingMode 'environment' failed:", err);
    }
  }

  // 5. If user wanted front camera:
  if (!stream && currentFacingMode === "user") {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
    } catch (err) {
      console.warn("facingMode 'user' failed:", err);
    }
  }

  // 6. Generic video fallback
  if (!stream) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (fallbackErr) {
      console.error("Camera access failed completely:", fallbackErr);
      if (statusEl) {
        statusEl.textContent = "Camera unavailable. Please check permissions.";
      }
      return;
    }
  }

  // Scanner was closed or restarted while the camera was opening
  if (isStale()) {
    stopTracks(stream);
    return;
  }

  videoStream = stream;
  video.srcObject = videoStream;
  await playVideo(video);
  if (isStale()) return;

  // Inspect track and ensure we didn't end up on front camera when wanting rear
  try {
    const track = videoStream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableVideoDevices = devices.filter((d) => d.kind === "videoinput");

    if (currentFacingMode === "environment" && settings?.facingMode === "user" && availableVideoDevices.length > 1 && !preferDeviceId) {
      const backDevice = availableVideoDevices.find((d) => {
        const lbl = (d.label || "").toLowerCase();
        return lbl.includes("back") || lbl.includes("rear") || lbl.includes("environment") || lbl.includes("facing back");
      }) || availableVideoDevices.find((d) => d.deviceId !== settings.deviceId);

      if (backDevice && backDevice.deviceId !== settings.deviceId) {
        stopTracks(videoStream);
        videoStream = null;
        video.srcObject = null;
        const backStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: backDevice.deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        if (isStale()) {
          stopTracks(backStream);
          return;
        }
        videoStream = backStream;
        video.srcObject = videoStream;
        await playVideo(video);
        if (isStale()) return;
      }
    }

    const switchBtn = $("#switch-camera-btn");
    if (switchBtn) {
      if (availableVideoDevices.length > 1) {
        switchBtn.classList.remove("hidden");
      } else {
        switchBtn.classList.add("hidden");
      }
    }
  } catch (err) {
    console.warn("Could not inspect camera devices/settings:", err);
  }

  requestAnimationFrame(tick);
}

// play() rejects with AbortError when srcObject changes before playback starts
// (scanner closed or camera switched mid-start); that's expected, not an error.
async function playVideo(video) {
  try {
    await video.play();
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.warn("Camera preview failed to play:", err);
    }
  }
}

function stopTracks(stream) {
  stream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (_) {}
  });
}

function stopCamera() {
  cameraGeneration++;
  if (scanAnimationFrame) {
    cancelAnimationFrame(scanAnimationFrame);
    scanAnimationFrame = null;
  }
  if (videoStream) {
    stopTracks(videoStream);
    videoStream = null;
  }
  const video = $("#qr-scanner-video");
  if (video) {
    video.srcObject = null;
  }
}

async function tick() {
  if (!isScanning || isBridgeProcessing) return;

  const video = $("#qr-scanner-video");
  if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
    let foundCode = null;

    // Try native hardware accelerated BarcodeDetector first
    if (barcodeDetector) {
      try {
        const barcodes = await barcodeDetector.detect(video);
        if (barcodes.length > 0 && barcodes[0].rawValue) {
          foundCode = barcodes[0].rawValue;
        }
      } catch (_) {
        // Fallback to jsQR
      }
    }

    // Fallback to jsQR if native detector not available or didn't find anything
    if (!foundCode && typeof jsQR === "function") {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: "dontInvert"
        });
        if (result && result.data) {
          foundCode = result.data;
        }
      } catch (_) {}
    }

    if (foundCode) {
      handleScannedData(foundCode);
      return;
    }
  }

  if (isScanning && !isBridgeProcessing) {
    scanAnimationFrame = requestAnimationFrame(tick);
  }
}

export function extractRoomAndKey(data) {
  if (!data) return { roomId: null, key: null };
  const trimmed = data.trim();
  let roomId = null;
  let key = null;

  try {
    const url = new URL(trimmed, window.location.href);
    roomId = url.searchParams.get("room")?.trim() || null;
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      key = hashParams.get("key") || hashParams.get("k") || null;
    }
  } catch (_) {}

  if (!roomId && trimmed.includes("room=")) {
    const match = trimmed.match(/room=([a-zA-Z0-9_-]+)/);
    if (match) roomId = match[1];
    const keyMatch = trimmed.match(/[#&]key=([a-zA-Z0-9_-]+)/);
    if (keyMatch) key = keyMatch[1];
  }

  if (!roomId && /^[a-zA-Z0-9_-]{6,32}$/.test(trimmed)) {
    roomId = trimmed;
  }

  return { roomId, key };
}

function extractRoomId(data) {
  return extractRoomAndKey(data).roomId;
}

async function handleScannedData(rawData) {
  if (isBridgeProcessing) return;

  const statusEl = $("#scanner-status");
  const { roomId: targetRoomId, key: scannedKey } = extractRoomAndKey(rawData);

  if (!targetRoomId) {
    if (statusEl) statusEl.textContent = "Unrecognized QR code. Please scan a Handoff QR code.";
    return;
  }

  // If in custom scan handler mode (e.g. Pairing phone with PC)
  if (typeof customScanHandler === "function") {
    isBridgeProcessing = true;
    isScanning = false;

    // Haptic feedback if supported
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(80);
      }
    } catch (_) {}

    if (statusEl) {
      statusEl.textContent = "✓ Connected to computer!";
    }

    const handler = customScanHandler;
    customScanHandler = null;

    stopCamera();
    closeBridgeScanner();
    handler(targetRoomId, scannedKey);
    return;
  }

  // Prevent scanning Computer 1's code again in bridge mode
  if (targetRoomId === state.roomId) {
    if (statusEl) {
      statusEl.textContent = "That’s Computer 1’s QR code! Please scan Computer 2.";
    }
    return;
  }

  // Valid Computer 2 detected!
  isBridgeProcessing = true;
  isScanning = false;

  // Haptic feedback if supported
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(80);
    }
  } catch (_) {}

  if (statusEl) {
    statusEl.textContent = "✓ Computer 2 detected! Linking computers…";
  }

  stopCamera();
  await bridgeComputers(targetRoomId);
}

async function bridgeComputers(computer2RoomId) {
  const computer1RoomId = state.roomId;
  const statusEl = $("#scanner-status");

  try {
    if (statusEl) {
      statusEl.textContent = "Transmitting bridge handshake…";
    }

    // Connect temporarily to Computer 2's room channel to instruct it to join Room 1
    const computer2Channel = supabase.channel(`handoff:${computer2RoomId}`);

    await new Promise((resolve) => {
      computer2Channel.subscribe(async (subStatus) => {
        if (subStatus === "SUBSCRIBED") {
          // Send redirect broadcast to Computer 2
          await computer2Channel.send({
            type: "broadcast",
            event: "room:redirect",
            payload: {
              targetRoomId: computer1RoomId,
              bridgedBy: "phone",
              cryptoKey: state.cryptoKeyBase64,
              timestamp: Date.now()
            }
          });

          // Inform Computer 1 that a 2nd computer is connecting
          if (state.channel) {
            state.channel.send({
              type: "broadcast",
              event: "bridge:pending",
              payload: {
                targetRoomId: computer1RoomId
              }
            });
          }

          // Unsubscribe from temporary bridge channel
          setTimeout(() => {
            try {
              computer2Channel.unsubscribe();
            } catch (_) {}
          }, 1500);

          resolve();
        }
      });

      // Timeout safety: resolve after 4 seconds regardless
      setTimeout(resolve, 4000);
    });

    // Close scanner modal
    if (history.state?.modal === "bridge-scanner") {
      try {
        history.back();
      } catch (_) {}
    }
    $("#qr-scanner-modal")?.classList.add("hidden");

    // Show success modal
    const successModal = $("#bridge-success-modal");
    if (successModal) {
      successModal.classList.remove("hidden");
    }

    // Auto disconnect after 3.5 seconds
    setTimeout(() => {
      finishPhoneHandoff();
    }, 3500);
  } catch (err) {
    console.error("Failed to bridge computers:", err);
    if (statusEl) {
      statusEl.textContent = "Bridge failed. Please try scanning again.";
    }
    isBridgeProcessing = false;
    isScanning = true;
    startCamera();
  }
}

function finishPhoneHandoff() {
  const successModal = $("#bridge-success-modal");
  successModal?.classList.add("hidden");

  // Phone exits the session as requested
  if (state.channel) {
    try {
      state.channel.unsubscribe();
    } catch (_) {}
    state.channel = null;
  }

  resetToHome("✓ Both computers paired! Phone has left the session.");
}
