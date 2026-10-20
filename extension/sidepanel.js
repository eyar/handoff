import { APP_URL } from "./config.js";

const APP_ORIGIN = new URL(APP_URL).origin;
const frame = document.getElementById("app");
const toast = document.getElementById("toast");

let appReady = false;
let flushing = false;
let toastTimer = null;
let handshakeTimer = null;
let noteForNextConfirmation = null; // e.g. "sent the image's link instead", shown with the app's confirmation

frame.src = `${APP_URL}/?embed=extension`;

function showToast(message, ms = 3500) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

function postToApp(type, data = {}) {
  frame.contentWindow?.postMessage({ source: "handoff-extension", type, ...data }, APP_ORIGIN);
}

// The app (re)loads: say hello so it knows to accept our messages
frame.addEventListener("load", () => {
  appReady = false;
  postToApp("hello");
  clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(warnIfAppSilent, 4000);
});

// No reply means the page can't take items from the extension (offline, outdated site, or not allowlisted)
async function warnIfAppSilent() {
  if (appReady) return;
  const { queue = [] } = await chrome.storage.session.get("queue");
  if (queue.length > 0) {
    showToast("Couldn't connect to Handoff, so nothing was sent. Check your connection and reopen the panel.", 8000);
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== APP_ORIGIN || event.source !== frame.contentWindow) return;
  const msg = event.data;
  if (msg?.source !== "handoff-app") return;

  if (msg.type === "status") {
    appReady = true;
    clearTimeout(handshakeTimer);
    flushQueue();
  } else if (msg.type === "accepted") {
    const note = noteForNextConfirmation ? ` ${noteForNextConfirmation}` : "";
    noteForNextConfirmation = null;
    if (!msg.ok) {
      showToast("Couldn't send that. Try again from the Handoff panel.");
    } else if (msg.pending) {
      showToast(`Ready to send — scan the QR code with your phone and it will arrive automatically.${note}`, 6000);
    } else {
      showToast(`${msg.kind === "files" ? "Sending to your phone…" : "Sent to your phone ✓"}${note}`, note ? 6000 : 3500);
    }
  }
});

function fileNameFor(srcUrl, mimeType) {
  try {
    const last = decodeURIComponent(new URL(srcUrl).pathname.split("/").pop() || "");
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return last.slice(0, 120);
  } catch {
    // data: or unusual URL
  }
  const ext = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/\+.*$/, "");
  return `image.${ext}`;
}

async function dataUrlToFile(dataUrl, srcUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], fileNameFor(srcUrl, blob.type || "image/jpeg"), { type: blob.type || "image/jpeg" });
}

// Fetch the image from inside the page that shows it (same cookies/origin as the page itself)
async function fetchImage(item) {
  if (item.srcUrl.startsWith("data:")) return dataUrlToFile(item.srcUrl, item.srcUrl);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: item.tabId },
    args: [item.srcUrl],
    func: async (src) => {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    },
  });
  if (typeof result?.result !== "string") throw new Error("Image could not be read");
  return dataUrlToFile(result.result, item.srcUrl);
}

async function deliver(item) {
  if (item.kind === "text") {
    postToApp("send-text", { text: item.text });
  } else if (item.kind === "image") {
    try {
      const file = await fetchImage(item);
      postToApp("send-files", { files: [file] });
    } catch (err) {
      console.warn("Image fetch failed, sending its link instead:", err);
      noteForNextConfirmation = "(That site doesn't allow copying the image, so its link was sent instead.)";
      postToApp("send-text", { text: item.srcUrl });
    }
  }
}

async function flushQueue() {
  if (!appReady || flushing) return;
  flushing = true;
  try {
    for (;;) {
      const { queue = [] } = await chrome.storage.session.get("queue");
      if (queue.length === 0) break;
      await chrome.storage.session.set({ queue: [] });
      for (const item of queue) await deliver(item);
    }
  } finally {
    flushing = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.queue?.newValue?.length) return;
  if (appReady) {
    flushQueue();
  } else {
    clearTimeout(handshakeTimer);
    handshakeTimer = setTimeout(warnIfAppSilent, 4000);
  }
});
