#!/usr/bin/env node
// One report for everything Handoff measures: Cloudflare traffic, the usage_events funnel and client_errors.
// Usage: npm run usage [-- --days 7] [-- --local]
// Cloudflare traffic needs CLOUDFLARE_API_TOKEN (with Account > Account Analytics > Read) and CLOUDFLARE_ZONE_ID in .env.
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const PROJECT_REF = "kljzghiiovsvymixqgrf";

const rawArgs = process.argv.slice(2);
const isLocal = rawArgs.some((a) => a === "--local" || a === "local" || a === "-l");
const daysIndex = rawArgs.indexOf("--days");
const days = Math.max(1, Math.min(90, Number(daysIndex >= 0 ? rawArgs[daysIndex + 1] : 30) || 30));

// Read variables from local .env if not already in process.env
function getEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.resolve(".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
      if (match) return match[1].trim();
    }
  } catch (_) {}
  return "";
}

const execAsync = promisify(exec);

async function query(sql) {
  const targetFlag = isLocal ? "--local" : `--linked --project-ref ${PROJECT_REF}`;
  const cmd = `supabase db query ${targetFlag} --agent yes "${sql.replace(/\s+/g, " ").replace(/"/g, '\\"')}"`;
  try {
    const { stdout } = await execAsync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout).rows || [];
  } catch (err) {
    console.error("Query failed:", err.stderr || err.message);
    process.exit(1);
  }
}

/**
 * Daily page views and visits from Cloudflare Web Analytics, or the reason they're missing. Web Analytics
 * counts page loads that ran its JavaScript beacon, so crawlers and scripted requests mostly aren't in it.
 */
async function cloudflareDaily() {
  const token = getEnv("CLOUDFLARE_API_TOKEN");
  const zoneId = getEnv("CLOUDFLARE_ZONE_ID");
  if (!token || !zoneId) return { error: "add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID to .env" };
  const api = async (pathname, init = {}) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    return res.json();
  };
  const needsPermission = "the API token needs Account > Account Analytics > Read";
  try {
    const zone = await api(`/zones/${zoneId}`);
    const accountId = zone.result?.account?.id;
    if (!accountId) return { error: zone.errors?.[0]?.message || "couldn't look up the zone's account" };

    // Over long ranges Cloudflare answers from a sample (every day becomes a round 10, 20…, and quiet days
    // drop out), so ask for one week at a time, all weeks at once. Data older than about a week is only kept
    // as a 1-in-10 sample, so those days stay estimates and are marked with ~
    const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
    const weeks = [];
    for (let start = days - 1; start >= 0; start -= 7) weeks.push([day(start), day(Math.max(0, start - 6))]);
    const bodies = await Promise.all(weeks.map(([from, to]) => api("/graphql", {
      method: "POST",
      body: JSON.stringify({ query: `{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
        rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [date_ASC],
          filter: { requestHost: "${zone.result.name}", date_geq: "${from}", date_leq: "${to}" }) {
          count sum { visits } avg { sampleInterval } dimensions { date } } } } }` })
    })));
    const errors = bodies.flatMap((body) => body.errors || []);
    if (errors.length) {
      const denied = errors.some((e) => e.extensions?.code === "authz");
      return { error: denied ? needsPermission : errors[0].message };
    }
    const groups = bodies.flatMap((body) => body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []);
    return {
      byDay: new Map(groups.map((g) => {
        const mark = g.avg.sampleInterval > 1 ? "~" : "";
        return [g.dimensions.date, { pageViews: `${mark}${g.count}`, visits: `${mark}${g.sum.visits}` }];
      }))
    };
  } catch (err) {
    return { error: err.message };
  }
}

function pct(part, whole) {
  return whole ? `${((100 * part) / whole).toFixed(1)}%` : "";
}

// Query rows come back with their keys sorted, so callers that care name the column order
function printTable(title, rows, columns = rows[0] ? Object.keys(rows[0]) : []) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (nothing yet)");
    return;
  }
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (values) => `  ${values.map((v, i) => v.padEnd(widths[i])).join("  ")}`;
  console.log(line(columns));
  console.log(line(widths.map((w) => "-".repeat(w))));
  rows.forEach((r) => console.log(line(columns.map((c) => cell(r[c])))));
}

const since = `created_at >= NOW() - INTERVAL '${days} days'`;
const funnelColumns = `
  COUNT(*) FILTER (WHERE event = 'visit') AS visits,
  COUNT(*) FILTER (WHERE event = 'paired') AS paired`;

// Every section in one round trip: each becomes a JSON array under its own key
const sections = {
  daily: [`
    SELECT created_at::date AS day, ${funnelColumns},
      COUNT(*) FILTER (WHERE event = 'transfer' AND props->>'kind' = 'file') AS files,
      COUNT(*) FILTER (WHERE event = 'transfer' AND props->>'kind' = 'file' AND props->>'outcome' = 'failed') AS failed,
      COUNT(*) FILTER (WHERE event = 'transfer' AND props->>'kind' = 'text') AS texts
    FROM public.usage_events WHERE ${since} GROUP BY 1`, "day"],
  dailyErrors: [`
    SELECT created_at::date AS day, COUNT(*) AS errors FROM public.client_errors WHERE ${since} GROUP BY 1`, "day"],
  byEntry: [`
    SELECT props->>'entry' AS entry, ${funnelColumns}
    FROM public.usage_events WHERE ${since} AND event IN ('visit', 'paired') GROUP BY 1`, "visits DESC"],
  byDevice: [`
    SELECT props->>'os' AS os, ${funnelColumns}
    FROM public.usage_events WHERE ${since} AND event IN ('visit', 'paired') GROUP BY 1`, "visits DESC"],
  waits: [`
    SELECT props->>'wait' AS wait, COUNT(*) AS paired,
      MIN(CASE props->>'wait' WHEN '<30s' THEN 1 WHEN '30s-2m' THEN 2 WHEN '2-10m' THEN 3 ELSE 4 END) AS rank
    FROM public.usage_events WHERE ${since} AND event = 'paired' GROUP BY 1`, "rank"],
  pairTypes: [`
    SELECT props->>'pair' AS pair, props->>'os' AS os, props->>'peer_ios' AS peer_ios, COUNT(*) AS paired
    FROM public.usage_events WHERE ${since} AND event = 'paired' GROUP BY 1, 2, 3`, "paired DESC"],
  transfers: [`
    SELECT props->>'kind' AS kind, props->>'from' AS sent_from, props->>'pair' AS pair, props->>'size' AS size,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE props->>'outcome' = 'ok') AS ok,
      COUNT(*) FILTER (WHERE props->>'outcome' = 'failed') AS failed,
      COUNT(*) FILTER (WHERE props->>'outcome' = 'cancelled') AS cancelled
    FROM public.usage_events WHERE ${since} AND event = 'transfer' GROUP BY 1, 2, 3, 4`, "total DESC"],
  errors: [`
    SELECT event_type, LEFT(error_message, 70) AS message, COUNT(*) AS n
    FROM public.client_errors GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`, "n DESC"]
};
const reportSql = `SELECT json_build_object(${Object.entries(sections)
  .map(([key, [sql, order]]) => `'${key}', (SELECT COALESCE(json_agg(t ORDER BY ${order}), '[]'::json) FROM (${sql}) t)`)
  .join(", ")}) AS report`;

const [rows, cloudflare] = await Promise.all([
  query(reportSql),
  isLocal ? { error: "not shown for --local" } : cloudflareDaily()
]);
const raw = rows[0]?.report || {};
const report = typeof raw === "string" ? JSON.parse(raw) : raw;
const withPairRate = (r) => ({ ...r, pair_rate: pct(r.paired, r.visits) });

const usageByDay = new Map(report.daily.map((r) => [r.day, r]));
const errorsByDay = new Map(report.dailyErrors.map((r) => [r.day, r.errors]));
const allDays = new Set([...usageByDay.keys(), ...errorsByDay.keys(), ...(cloudflare.byDay?.keys() || [])]);

console.log(`Handoff usage, last ${days} days (${isLocal ? "local" : "hosted"})`);

printTable("Daily", [...allDays].sort().map((day) => {
  const u = usageByDay.get(day) || {};
  const cf = cloudflare.byDay?.get(day);
  return {
    day,
    page_views: cf?.pageViews,
    cf_visits: cf?.visits,
    app_visits: u.visits || 0,
    paired: u.paired || 0,
    pair_rate: pct(u.paired || 0, u.visits || 0),
    files: u.files || 0,
    failed: u.failed || 0,
    texts: u.texts || 0,
    errors: errorsByDay.get(day) || 0
  };
}));
if (cloudflare.error) console.log(`  page_views and cf_visits are blank: ${cloudflare.error}.`);
console.log("  page_views/cf_visits are Cloudflare Web Analytics page loads in real browsers (~ = estimated from a 1-in-10 sample);\n  app_visits are app opens. Errors are kept for 48 hours.");

printTable("Pairing rate by entry point", report.byEntry.map(withPairRate), ["entry", "visits", "paired", "pair_rate"]);
printTable("Pairing rate by device", report.byDevice.map(withPairRate), ["os", "visits", "paired", "pair_rate"]);
printTable("Time from opening to paired", report.waits, ["wait", "paired"]);
printTable("Pair types", report.pairTypes, ["pair", "os", "peer_ios", "paired"]);
printTable("Transfers", report.transfers.map((r) => ({ ...r, ok_rate: pct(r.ok, r.total) })),
  ["kind", "sent_from", "pair", "size", "total", "ok", "failed", "cancelled", "ok_rate"]);
printTable("Errors in the last 48 hours", report.errors, ["event_type", "message", "n"]);
