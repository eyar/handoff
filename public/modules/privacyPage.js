// Privacy page: the switch for this browser's anonymous usage counts and error reports.
import { browserOptedOut, telemetryAllowed, setTelemetryEnabled } from "./telemetry.js";

const box = document.getElementById("telemetry-control");
const status = document.getElementById("telemetry-status");
const btn = document.getElementById("telemetry-toggle");

if (box && status && btn) {
  const render = () => {
    if (browserOptedOut()) {
      // Global Privacy Control / Do Not Track already turned it off; there's nothing to switch
      status.textContent = "Off: your browser asks sites not to track, so Handoff sends no usage counts or error reports.";
      btn.hidden = true;
      return;
    }
    const on = telemetryAllowed();
    status.textContent = on
      ? "On: this browser sends anonymous usage counts and error reports."
      : "Off: this browser sends no usage counts or error reports.";
    btn.textContent = on ? "Turn off" : "Turn on";
  };
  btn.addEventListener("click", () => {
    setTelemetryEnabled(!telemetryAllowed());
    render();
  });
  render();
  box.hidden = false;
}
