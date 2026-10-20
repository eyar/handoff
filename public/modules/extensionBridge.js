// Lets the Handoff browser extension (side panel) hand text and files to this page.
// Only active when embedded by an allowlisted extension; it accepts commands and reports pairing
// status, and never exposes anything received from the phone.
import { state } from "./state.js";
import { $ } from "./dom.js";
import { EXTENSION_ORIGINS } from "./constants.js";

// Captured at load: the app later cleans its URL with history.replaceState
const embeddedByExtension =
  typeof window !== "undefined" &&
  window.parent !== window &&
  new URLSearchParams(location.search).get("embed") === "extension";

let parentOrigin = null; // set by the extension's "hello" handshake
let paired = false;
let sendFilesWhenPaired = false;

function post(type, data = {}) {
  if (!parentOrigin) return;
  window.parent.postMessage({ source: "handoff-app", type, ...data }, parentOrigin);
}

function isTrusted(event) {
  return (
    window.parent !== window &&
    event.source === window.parent &&
    EXTENSION_ORIGINS.includes(event.origin) &&
    event.data?.source === "handoff-extension"
  );
}

function sendTextFromExtension(text) {
  const textarea = $("#desktop-text");
  if (!textarea || typeof text !== "string" || !text.trim()) return false;
  textarea.value = text;
  // The live text box syncs (encrypted) when paired, and is re-sent automatically on pairing
  state.desktopTextSync?.onInput();
  return true;
}

async function sendFilesFromExtension(files) {
  const uploader = state.desktopFileUpload;
  const list = Array.isArray(files) ? files.filter((f) => f instanceof File) : [];
  if (!uploader || list.length === 0) return false;
  await uploader.addFiles(list);
  if (paired) {
    await uploader.startUpload();
  } else {
    sendFilesWhenPaired = true; // staged until the phone connects
  }
  return true;
}

async function handleMessage(event) {
  if (!isTrusted(event)) return;
  const { type } = event.data;

  if (type === "hello") {
    parentOrigin = event.origin;
    post("status", { paired });
    return;
  }
  if (!parentOrigin) return;

  if (type === "send-text") {
    const ok = sendTextFromExtension(event.data.text);
    post("accepted", { kind: "text", ok, pending: ok && !paired });
  } else if (type === "send-files") {
    const ok = await sendFilesFromExtension(event.data.files);
    post("accepted", { kind: "files", ok, pending: ok && !paired });
  }
}

// Called by the pairing UI whenever a phone (or other computer) connects or the session resets
export function notifyPairingChanged(isPaired) {
  paired = Boolean(isPaired);
  post("status", { paired });
  if (paired && sendFilesWhenPaired) {
    sendFilesWhenPaired = false;
    if (state.desktopFileUpload?.getStagedFiles().length) state.desktopFileUpload.startUpload();
  }
}

// In the extension's side panel the pairing QR should show right away, without the start screen
export function isEmbeddedByExtension() {
  return embeddedByExtension;
}

export function initExtensionBridge() {
  if (window.parent === window) return;
  if (embeddedByExtension) document.documentElement.classList.add("embed-extension");
  window.addEventListener("message", handleMessage);
}
