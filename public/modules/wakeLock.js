// Screen Wake Lock helper: keeps the screen on while transfers are in progress.
// Reference-counted so multiple uploaders (desktop + phone) can hold it safely.
// The browser auto-releases the lock when the page is hidden, so we re-acquire
// it on visibilitychange while any holder is still active.

let holders = 0;
let sentinel = null;

const isSupported = () =>
  typeof navigator !== "undefined" && "wakeLock" in navigator;

async function requestLock() {
  if (!isSupported() || sentinel || holders === 0) return;
  if (document.visibilityState !== "visible") return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
    // A release may have happened while the request was pending
    if (holders === 0) {
      releaseLock();
    }
  } catch (err) {
    // Denied (e.g. low battery mode, permissions policy) — non-fatal
    console.warn("Screen wake lock unavailable:", err?.message || err);
    sentinel = null;
  }
}

function releaseLock() {
  const current = sentinel;
  sentinel = null;
  current?.release().catch(() => {});
}

export function acquireWakeLock() {
  holders++;
  requestLock();
}

export function releaseWakeLock() {
  holders = Math.max(0, holders - 1);
  if (holders === 0) releaseLock();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && holders > 0) {
      requestLock();
    }
  });
}
