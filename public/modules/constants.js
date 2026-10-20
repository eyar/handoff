export const MAX_TEXT_LENGTH = 10_000;
export const MAX_FILE_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB limit (all transfers 100% free)
// Share loads the whole file into memory before opening the share sheet, which
// reloads iOS Safari tabs well before 1.5GB. Larger files get Download only.
export const MAX_SHARE_FILE_SIZE = 200 * 1024 * 1024;
export const STORAGE_BUCKET = "handoff-files";
export const FILE_TTL_MS = 15 * 60 * 1000; // 15 minutes per file
export const PAID_FILE_TTL_MS = FILE_TTL_MS; // Backwards compatibility alias
export const TEXT_TTL_MS = 60 * 1000; // 1 minute (60 seconds)
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_PARALLEL_UPLOADS = 2; // Up to 2 concurrent file uploads
// Browser extensions allowed to embed Handoff and hand it text/files (see modules/extensionBridge.js).
// Add the Edge Add-ons ID too once it is published there.
export const EXTENSION_ORIGINS = [
  "chrome-extension://jmjapgakklfhafbgheccblmkhnmbmnkd", // Chrome Web Store: "Handoff — Send to Phone"
  "chrome-extension://fpebcbfmfdmfefgilaogdkojfpcbclkp" // unpacked dev build (fixed by "key" in extension/manifest.json)
];

