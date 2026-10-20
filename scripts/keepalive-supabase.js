#!/usr/bin/env node

/**
 * Supabase Free-Tier Keep-Alive Ping Script
 *
 * Prevents Supabase projects from pausing due to 7 days of inactivity
 * by issuing a lightweight SQL read via PostgREST to public.app_config.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://kljzghiiovsvymixqgrf.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_CrO5DO9HYvrCJUrkow24AQ_uB14CVX2";

async function pingSupabase() {
  const startTime = Date.now();
  const endpoint = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/app_config?select=*`;

  console.log(`[keepalive] Pinging Supabase database...`);
  console.log(`[keepalive] Target: ${endpoint}`);
  console.log(`[keepalive] Time:   ${new Date().toISOString()}`);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "Handoff-KeepAlive/1.0"
      }
    });

    const elapsedMs = Date.now() - startTime;
    const text = await response.text();

    if (!response.ok) {
      console.error(`[keepalive] ❌ Failed with HTTP status ${response.status} (${elapsedMs}ms)`);
      console.error(`[keepalive] Response: ${text}`);
      process.exit(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    console.log(`[keepalive] ✅ Success! Received HTTP ${response.status} in ${elapsedMs}ms`);
    console.log(`[keepalive] Database payload:`, JSON.stringify(parsed));
    console.log(`[keepalive] Activity registered with Supabase project. Pause timer reset.`);
  } catch (err) {
    console.error(`[keepalive] ❌ Network/Request error:`, err.message);
    process.exit(1);
  }
}

pingSupabase();
