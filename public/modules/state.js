export const state = {
  deviceId: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14),
  channel: null,
  roomId: null,
  currentRole: null,
  isSessionPaid: false,
  activeCheckoutTransactionId: null,
  sharedTextExpiresAt: null,
  sharedFiles: [],
  selectedFileIds: new Set(),
  roomUploadedFiles: new Set(),
  activeFileUploadSetups: [],
  incomingFileTransfers: new Map(),
  desktopTextSync: null,
  phoneTextSync: null,
  desktopFileUpload: null,
  phoneFileUpload: null,
  isMaintenanceActive: false,
  qrFromComputer: false,
  isTargetWindows: false,
  cryptoKey: null,
  cryptoKeyBase64: null,
  isPeerE2ee: false
};

export function getRole() {
  if (state.currentRole) return state.currentRole;
  const phone = document.querySelector("#phone");
  const computer = document.querySelector("#computer");
  if (phone && !phone.classList.contains("hidden")) return "phone";
  if (computer && !computer.classList.contains("hidden")) return "computer";
  return location.search.includes("room=") ? "phone" : "computer";
}

export function resetState() {
  state.channel = null;
  state.roomId = null;
  state.currentRole = null;
  state.isSessionPaid = false;
  state.activeCheckoutTransactionId = null;
  state.sharedTextExpiresAt = null;
  state.sharedFiles = [];
  state.selectedFileIds.clear();
  state.roomUploadedFiles.clear();
  state.incomingFileTransfers.clear();
  state.qrFromComputer = false;
  state.isTargetWindows = false;
  state.cryptoKey = null;
  state.cryptoKeyBase64 = null;
  state.isPeerE2ee = false;
}
