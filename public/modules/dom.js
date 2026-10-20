export const $ = (selector) => document.querySelector(selector);

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function getFileEmoji(fileName, mimeType = "") {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (mimeType.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "heic"].includes(ext)) return "🖼️";
  if (mimeType.startsWith("video/") || ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)) return "🎬";
  if (mimeType.startsWith("audio/") || ["mp3", "m4a", "wav", "flac", "ogg", "aac"].includes(ext)) return "🎵";
  if (mimeType === "application/pdf" || ext === "pdf") return "📕";
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "📦";
  if (["doc", "docx", "pages", "odt"].includes(ext)) return "📝";
  if (["xls", "xlsx", "numbers", "csv"].includes(ext)) return "📊";
  if (["ppt", "pptx", "key"].includes(ext)) return "📽️";
  if (["js", "ts", "json", "html", "css", "py", "sh", "sql"].includes(ext)) return "💻";
  return "📄";
}

export function formatFileRemaining(fileExpiresAt) {
  if (!fileExpiresAt) return "";
  const remaining = Math.max(0, fileExpiresAt - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function show(name) {
  const sections = { home: $("#home"), computer: $("#computer"), phone: $("#phone") };

  Object.entries(sections).forEach(([key, section]) => {
    section?.classList.toggle("hidden", key !== name);
  });
}

export function setStatus(element, message) {
  if (element) element.textContent = message;
}

export function isDesktopComputer() {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent || "";
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isIpadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (isMobileUa || isIpadOs) return false;
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
    return !navigator.userAgentData.mobile;
  }
  return true;
}

export function isWindowsPlatform() {
  if (typeof navigator === "undefined") return false;
  if (navigator.userAgentData?.platform) {
    return navigator.userAgentData.platform.toLowerCase().includes("win");
  }
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /Win32|Win64|Windows|WinCE/i.test(platform) || /Windows/i.test(ua);
}

export function generateSecureToken(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    let result = "";
    const randomBytes = new Uint8Array(length * 2);
    while (result.length < length) {
      crypto.getRandomValues(randomBytes);
      for (let i = 0; i < randomBytes.length && result.length < length; i++) {
        if (randomBytes[i] < 252) {
          result += chars[randomBytes[i] % 36];
        }
      }
    }
    return result;
  }
  let fallback = "";
  for (let i = 0; i < length; i++) {
    fallback += chars[Math.floor(Math.random() * chars.length)];
  }
  return fallback;
}
