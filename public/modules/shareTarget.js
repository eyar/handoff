import { state, getRole } from "./state.js";
import { $, setStatus } from "./dom.js";

const DB_NAME = "handoff_share_db";
const DB_VERSION = 1;
const STORE_NAME = "shares";

/**
 * Opens the IndexedDB database used to bridge shared content from Service Worker to client.
 */
function openShareDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB not supported"));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieves and clears all queued share target payloads from IndexedDB.
 */
export async function getAndClearPendingShares() {
  try {
    const db = await openShareDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = () => {
        const items = req.result || [];
        if (items.length > 0) {
          store.clear();
        }
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn("[ShareTarget] Could not read shares from IndexedDB:", err);
    return [];
  }
}

/**
 * Ingests shared files and text into the active room or stages them ready for pairing.
 */
export async function processSharedPayload(payload, startComputerSession) {
  if (!payload) return;

  const { title = "", text = "", url = "", files = [] } = payload;
  const currentRole = getRole();

  // 1. Process Shared Files
  if (Array.isArray(files) && files.length > 0) {
    const normalizedFiles = files.map((file, idx) => {
      if (file instanceof File) return file;
      const type = file.type || "application/octet-stream";
      const ext = type.split("/")[1]?.replace("+xml", "") || "bin";
      const name = file.name || `shared-file-${Date.now()}${idx > 0 ? `-${idx + 1}` : ""}.${ext}`;
      return new File([file], name, { type, lastModified: Date.now() });
    });

    if (currentRole === "phone" && state.roomId) {
      state.phoneFileUpload?.addFiles(normalizedFiles);
      setStatus($("#phone-file-status"), `✓ Received ${normalizedFiles.length} file(s) from Share Sheet`);
    } else if (state.roomId) {
      state.desktopFileUpload?.addFiles(normalizedFiles);
      setStatus($("#desktop-file-status"), `✓ Received ${normalizedFiles.length} file(s) from Share Sheet`);
    } else if (typeof startComputerSession === "function") {
      // Not yet paired: start a session and stage files ready to send when peer connects
      startComputerSession();
      setTimeout(() => {
        state.desktopFileUpload?.addFiles(normalizedFiles);
        setStatus(
          $("#desktop-file-status"),
          `✓ Received ${normalizedFiles.length} file(s) from Share Sheet. Ready to send!`
        );
      }, 100);
    }
  }

  // 2. Process Shared Text or URL
  const combinedText = [text, url].filter(Boolean).join("\n") || title;
  if (combinedText.trim()) {
    if (currentRole === "phone" && state.roomId) {
      const phoneText = $("#phone-text");
      if (phoneText) {
        phoneText.value = combinedText;
        phoneText.dispatchEvent(new Event("input", { bubbles: true }));
        try {
          if (typeof state.phoneTextSync?.syncNow === "function") {
            state.phoneTextSync.syncNow();
          } else if (typeof state.phoneTextSync?.onInput === "function") {
            state.phoneTextSync.onInput();
          }
        } catch (syncErr) {
          console.warn("Failed to sync shared text:", syncErr);
        }
        setStatus($("#phone-result"), "✓ Shared text received from Share Sheet");
      }
    } else {
      if (!state.roomId && typeof startComputerSession === "function") {
        startComputerSession();
      }
      setTimeout(() => {
        const desktopText = $("#desktop-text");
        if (desktopText) {
          desktopText.value = combinedText;
          desktopText.dispatchEvent(new Event("input", { bubbles: true }));
          try {
            if (typeof state.desktopTextSync?.syncNow === "function") {
              state.desktopTextSync.syncNow();
            } else if (typeof state.desktopTextSync?.onInput === "function") {
              state.desktopTextSync.onInput();
            }
          } catch (syncErr) {
            console.warn("Failed to sync shared text:", syncErr);
          }
          setStatus($("#desktop-text-status"), "✓ Shared text received from Share Sheet");
        }
      }, 100);
    }
  }
}

/**
 * Initializes Service Worker registration and Web Share Target queue consumers.
 */
export function initShareTarget(startComputerSession) {
  // 1. Clean the address bar if landed on ?shared=1
  if (location.search.includes("shared=1")) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("shared");
      const cleanPath = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : "");
      history.replaceState(null, "", cleanPath);
    } catch (_) {}
  }

  // 2. Register Service Worker for PWA and Web Share Target
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // Check for updates to service worker
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn("[ShareTarget] ServiceWorker registration failed:", err);
      });

    // Listen for real-time messages from Service Worker when a share arrives
    navigator.serviceWorker.addEventListener("message", async (event) => {
      if (event.data?.type === "SHARE_TARGET_RECEIVED") {
        const shares = await getAndClearPendingShares();
        for (const share of shares) {
          await processSharedPayload(share, startComputerSession);
        }
      }
    });
  }

  // 3. Process any pending shares on page load (e.g. after POST-redirect-GET)
  getAndClearPendingShares().then(async (shares) => {
    for (const share of shares) {
      await processSharedPayload(share, startComputerSession);
    }
  });
}
