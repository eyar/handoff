import { supabase } from "./supabaseClient.js";
import { state } from "./state.js";
import { recordDiagnostic } from "./diagnostics.js";

let configChannel = null;

export function activateMaintenanceMode(message) {
  state.isMaintenanceActive = true;
  document.body.classList.add("maintenance-mode");

  let banner = document.getElementById("maintenance-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "maintenance-banner";
    banner.className = "maintenance-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `
      <span class="maintenance-icon" aria-hidden="true">⚠️</span>
      <span class="maintenance-text" id="maintenance-text"></span>
    `;
    document.body.prepend(banner);
  }

  const textEl = document.getElementById("maintenance-text");
  if (textEl) {
    textEl.textContent = message || "Handoff is temporarily paused for maintenance. Transfers will resume shortly.";
  }
  banner.classList.remove("hidden");
  recordDiagnostic("kill_switch", "Maintenance mode active", { message });
}

export function deactivateMaintenanceMode() {
  state.isMaintenanceActive = false;
  document.body.classList.remove("maintenance-mode");
  const banner = document.getElementById("maintenance-banner");
  if (banner) {
    banner.classList.add("hidden");
  }
}

export async function initKillSwitch() {
  try {
    // 1. Initial check from app_config table
    const { data, error } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "kill_switch")
      .maybeSingle();

    if (!error && data?.value) {
      if (data.value.active) {
        activateMaintenanceMode(data.value.message);
      } else {
        deactivateMaintenanceMode();
      }
    }

    // 2. Realtime subscription to live updates
    if (!configChannel) {
      configChannel = supabase
        .channel("app_config_watch")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "app_config",
            filter: "key=eq.kill_switch",
          },
          (payload) => {
            const config = payload?.new?.value;
            if (config?.active) {
              activateMaintenanceMode(config.message);
            } else {
              deactivateMaintenanceMode();
            }
          }
        )
        .subscribe();
    }
  } catch (err) {
    console.warn("Could not check kill switch:", err);
  }
}
