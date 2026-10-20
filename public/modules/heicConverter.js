// HEIC to JPEG conversion utility
// Natively decodes HEIC on Safari (iOS / macOS) using Canvas 2D
// Falls back to on-demand heic2any WASM for non-Safari browsers

export function isHeicFile(file) {
  if (!file) return false;
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return (
    name.endsWith(".heic") ||
    name.endsWith(".heif") ||
    type === "image/heic" ||
    type === "image/heif"
  );
}

function convertWithCanvas(file, quality = 0.92) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return reject(new Error("DOM not available"));
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement("canvas");
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) {
          return reject(new Error("Image has invalid dimensions"));
        }
        let targetWidth = width;
        let targetHeight = height;
        const MAX_DIM = 4096;
        if (targetWidth > MAX_DIM || targetHeight > MAX_DIM) {
          if (targetWidth > targetHeight) {
            targetHeight = Math.round((targetHeight * MAX_DIM) / targetWidth);
            targetWidth = MAX_DIM;
          } else {
            targetWidth = Math.round((targetWidth * MAX_DIM) / targetHeight);
            targetHeight = MAX_DIM;
          }
        }
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return reject(new Error("Canvas 2D context not available"));
        }
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
              const convertedFile = new File([blob], newName, {
                type: "image/jpeg",
                lastModified: file.lastModified || Date.now()
              });
              resolve(convertedFile);
            } else {
              reject(new Error("canvas.toBlob produced null"));
            }
          },
          "image/jpeg",
          quality
        );
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

let heic2anyLoadingPromise = null;

async function loadHeic2Any() {
  if (typeof window === "undefined") return null;
  if (window.heic2any) return window.heic2any;

  if (heic2anyLoadingPromise) return heic2anyLoadingPromise;

  heic2anyLoadingPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    script.onload = () => {
      resolve(window.heic2any || null);
    };
    script.onerror = () => {
      console.warn("Failed to load heic2any script from CDN");
      resolve(null);
    };
    document.head.appendChild(script);
  });

  return heic2anyLoadingPromise;
}

async function convertWithHeic2Any(file, quality = 0.92) {
  const heic2any = await loadHeic2Any();
  if (typeof heic2any !== "function") {
    throw new Error("heic2any library not available");
  }
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality
  });
  const blob = Array.isArray(result) ? result[0] : result;
  const newName = file.name.replace(/\.(heic|heif)$/i, ".jpg");
  return new File([blob], newName, {
    type: "image/jpeg",
    lastModified: file.lastModified || Date.now()
  });
}

export async function convertHeicToJpeg(file, quality = 0.92) {
  if (!isHeicFile(file)) return file;

  // 1. Try native Canvas decoding first (instant on iOS/macOS Safari)
  try {
    return await convertWithCanvas(file, quality);
  } catch (canvasErr) {
    // 2. Fallback to heic2any WASM for non-Safari browsers
    try {
      return await convertWithHeic2Any(file, quality);
    } catch (wasmErr) {
      console.warn(`HEIC conversion failed for ${file.name}, using original:`, canvasErr, wasmErr);
      return file;
    }
  }
}
