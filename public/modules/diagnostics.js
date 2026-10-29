import { supabase } from "./supabaseClient.js";
import { state } from "./state.js";

const MAX_DIAGNOSTIC_EVENTS = 25;
const diagnosticEvents = [];
const loggedErrors = new Set();
let errorCount = 0;
const MAX_SERVER_LOGS_PER_SESSION = 5;

/**
 * Records a diagnostic event in the in-memory ring buffer (never persists PII).
 */
export function recordDiagnostic(category, message, details = null) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const entry = {
    time: timestamp,
    cat: category,
    msg: typeof message === "string" ? message : JSON.stringify(message)
  };
  if (details !== null && details !== undefined) {
    entry.data = details;
  }
  diagnosticEvents.push(entry);
  if (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    diagnosticEvents.shift();
  }
}

/**
 * Anonymously logs an error to the Supabase client_errors table (throttled & sanitized).
 */
export async function logErrorToSupabase(eventType, errorOrMsg, details = null) {
  try {
    const errorMsg = typeof errorOrMsg === "string"
      ? errorOrMsg
      : (errorOrMsg?.message || errorOrMsg?.name || "Unknown error");

    // Always record locally in memory
    recordDiagnostic(eventType, errorMsg, details);

    // Deduplicate and throttle database writes
    const dedupeKey = `${eventType}:${errorMsg}`;
    if (loggedErrors.has(dedupeKey) || errorCount >= MAX_SERVER_LOGS_PER_SESSION) {
      return;
    }
    loggedErrors.add(dedupeKey);
    errorCount++;

    const payload = {
      event_type: String(eventType).slice(0, 50),
      error_message: String(errorMsg).slice(0, 1000),
      error_details: details ? (typeof details === "object" ? details : { info: details }) : {},
      room_id: state.roomId || null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null
    };

    // Anonymous insert to client_errors (fails completely silently if offline or blocked)
    await supabase.from("client_errors").insert(payload);
  } catch (_) {
    // Non-blocking telemetry
  }
}

/**
 * Returns a sanitized diagnostic report object suitable for copy-pasting to support.
 */
export function getDiagnosticReport() {
  return {
    app: "Handoff",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    roomId: state.roomId || "none",
    role: state.currentRole || "unknown",
    isSessionPaid: Boolean(state.isSessionPaid),
    online: typeof navigator !== "undefined" ? navigator.onLine : true,
    realtimeConnected: Boolean(state.channel),
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "unknown",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    recentEvents: [...diagnosticEvents]
  };
}

/**
 * Copies the diagnostic report JSON to clipboard and returns success status.
 */
export async function copyDiagnostics() {
  const report = getDiagnosticReport();
  const json = JSON.stringify(report, null, 2);
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(json);
      return { success: true, text: json };
    }
  } catch (_) {}
  return { success: false, text: json };
}

export function isOwnScript(filename, origin = typeof location !== "undefined" ? location.origin : "") {
  if (!filename || !origin) return false;
  try {
    const url = new URL(filename);
    return url.origin === origin && url.pathname.endsWith(".js");
  } catch (_) {
    return false;
  }
}

/**
 * Initializes global uncaught error and unhandled rejection listeners.
 */
export function initGlobalErrorTracking() {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (event) => {
    // The page has no inline scripts, so anything not from our own .js files is a browser add-on or
    // userscript (e.g. Firefox for iOS's injected reader script), not a Handoff bug
    if (!isOwnScript(event?.filename)) return;
    const message = event?.message || "Script error";
    const filename = event?.filename ? event.filename.split("/").pop() : "";
    const lineno = event?.lineno || 0;
    const details = { file: filename, line: lineno };
    logErrorToSupabase("unhandled_error", message, details);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const message = reason?.message || String(reason || "Unhandled Promise Rejection");
    logErrorToSupabase("unhandled_rejection", message);
  });
}
