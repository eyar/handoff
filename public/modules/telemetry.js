// Whether this browser sends Handoff's anonymous usage counts and error reports.
// Off when the visitor turned it off in the footer, or when the browser asks sites not to track
// (Global Privacy Control or Do Not Track). Cloudflare Web Analytics is outside the app and not covered.
const OPT_OUT_KEY = "handoff_telemetry_off";

/** The browser itself asked not to be tracked, so there's nothing for the visitor to switch. */
export function browserOptedOut(nav = globalThis.navigator) {
  return nav?.globalPrivacyControl === true || nav?.doNotTrack === "1";
}

function visitorOptedOut() {
  try {
    return globalThis.localStorage?.getItem(OPT_OUT_KEY) === "1";
  } catch (_) {
    return false;
  }
}

export function telemetryAllowed() {
  return !browserOptedOut() && !visitorOptedOut();
}

export function setTelemetryEnabled(enabled) {
  try {
    if (enabled) globalThis.localStorage?.removeItem(OPT_OUT_KEY);
    else globalThis.localStorage?.setItem(OPT_OUT_KEY, "1");
  } catch (_) {}
}
