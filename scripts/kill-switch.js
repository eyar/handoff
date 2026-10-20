#!/usr/bin/env node
import { execSync } from "node:child_process";

const PROJECT_REF = "kljzghiiovsvymixqgrf";

// Local development values
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";

// Hosted / Production values
const PROD_URL = `https://${PROJECT_REF}.supabase.co`;
const PROD_KEY = "sb_publishable_CrO5DO9HYvrCJUrkow24AQ_uB14CVX2";

// Parse arguments flexibly
const rawArgs = process.argv.slice(2);
const isLocal = rawArgs.some((a) => a === "--local" || a === "local" || a === "-l");
const cleanArgs = rawArgs.filter((a) => a !== "--local" && a !== "local" && a !== "-l");
const command = (cleanArgs[0] || "status").toLowerCase();

async function fetchStatus(local) {
  const url = local ? LOCAL_URL : PROD_URL;
  const key = local ? LOCAL_KEY : PROD_KEY;
  try {
    const res = await fetch(`${url}/rest/v1/app_config?key=eq.kill_switch&select=*`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[0];
      }
    }
  } catch (_) {}
  return null;
}

function executeSql(sql, local) {
  const targetFlag = local ? "--local" : `--linked --project-ref ${PROJECT_REF}`;
  const sanitizedSql = sql.replace(/"/g, '\\"');
  const cmd = `supabase db query ${targetFlag} "${sanitizedSql}"`;
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function printStatus(record, targetName) {
  if (record?.value) {
    const config = record.value;
    if (config.active) {
      console.log(`🚨 KILL SWITCH IS ACTIVE on ${targetName} (Maintenance Mode ON)`);
      console.log(`💬 Message: "${config.message}"`);
      console.log(`🕒 Updated: ${record.updated_at}`);
      console.log("\nAll file uploads, room creations, and checkouts are BLOCKED.");
    } else {
      console.log(`✅ KILL SWITCH IS INACTIVE on ${targetName} (Normal Operations)`);
      console.log(`💬 Message: "${config.message || "Handoff is operating normally."}"`);
      console.log(`🕒 Updated: ${record.updated_at}`);
      console.log("\nFile transfers and checkouts are running normally.");
    }
  } else {
    console.log(`⚠️ No kill_switch config found in public.app_config on ${targetName}.`);
  }
}

async function main() {
  const targetName = isLocal ? "LOCAL (127.0.0.1:54321)" : `HOSTED (${PROJECT_REF})`;

  switch (command) {
    case "status": {
      console.log(`\n🔍 Checking Emergency Kill Switch status (${targetName})...\n`);
      const record = await fetchStatus(isLocal);
      printStatus(record, targetName);
      break;
    }

    case "on": {
      const customMessage = cleanArgs.slice(1).join(" ") ||
        "Handoff is temporarily paused for maintenance. Transfers will resume shortly.";
      console.log(`\n🚨 ACTIVATING EMERGENCY KILL SWITCH on ${targetName}...`);
      const escapedMsg = customMessage.replace(/'/g, "''");
      try {
        executeSql(`
          INSERT INTO public.app_config (key, value, updated_at)
          VALUES ('kill_switch', jsonb_build_object('active', true, 'message', '${escapedMsg}'), NOW())
          ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW();
        `, isLocal);
      } catch (err) {
        console.error("Database query failed:", err.message);
        process.exit(1);
      }

      console.log("✓ Kill switch ACTIVATED successfully!\n");
      const record = await fetchStatus(isLocal);
      printStatus(record, targetName);
      break;
    }

    case "off": {
      console.log(`\n🟢 DEACTIVATING KILL SWITCH on ${targetName}...`);
      try {
        executeSql(`
          UPDATE public.app_config
          SET value = jsonb_build_object('active', false, 'message', 'Handoff is operating normally.'), updated_at = NOW()
          WHERE key = 'kill_switch';
        `, isLocal);
      } catch (err) {
        console.error("Database query failed:", err.message);
        process.exit(1);
      }

      console.log("✓ Kill switch DEACTIVATED successfully!\n");
      const record = await fetchStatus(isLocal);
      printStatus(record, targetName);
      break;
    }

    default: {
      console.log("Usage:");
      console.log("  node scripts/kill-switch.js status [--local]");
      console.log("  node scripts/kill-switch.js on [custom message] [--local]");
      console.log("  node scripts/kill-switch.js off [--local]\n");
      break;
    }
  }
}

main().catch((err) => {
  console.error("Command error:", err);
  process.exit(1);
});
