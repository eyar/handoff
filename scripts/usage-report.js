#!/usr/bin/env node
// Prints the usage_events funnel: pairing rate, time to pair, pair types and transfer success.
// Usage: npm run usage [-- --days 7] [-- --local]
import { execSync } from "node:child_process";

const PROJECT_REF = "kljzghiiovsvymixqgrf";

const rawArgs = process.argv.slice(2);
const isLocal = rawArgs.some((a) => a === "--local" || a === "local" || a === "-l");
const daysIndex = rawArgs.indexOf("--days");
const days = Math.max(1, Math.min(90, Number(rawArgs[daysIndex + 1]) || 30));

function query(title, sql) {
  const targetFlag = isLocal ? "--local" : `--linked --project-ref ${PROJECT_REF}`;
  const cmd = `supabase db query ${targetFlag} --agent no "${sql.replace(/\s+/g, " ").replace(/"/g, '\\"')}"`;
  console.log(`\n${title}`);
  try {
    console.log(execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }));
  } catch (err) {
    console.error("Query failed:", err.stderr || err.message);
    process.exit(1);
  }
}

const since = `created_at >= NOW() - INTERVAL '${days} days'`;

console.log(`Handoff usage, last ${days} days (${isLocal ? "local" : "hosted"})`);

query("Pairing rate by entry point", `
  SELECT props->>'entry' AS entry,
    COUNT(*) FILTER (WHERE event = 'visit') AS visits,
    COUNT(*) FILTER (WHERE event = 'paired') AS paired,
    ROUND(100.0 * COUNT(*) FILTER (WHERE event = 'paired') / NULLIF(COUNT(*) FILTER (WHERE event = 'visit'), 0), 1) AS pct
  FROM public.usage_events WHERE ${since} AND event IN ('visit', 'paired')
  GROUP BY 1 ORDER BY visits DESC`);

query("Pairing rate by device", `
  SELECT props->>'os' AS os,
    COUNT(*) FILTER (WHERE event = 'visit') AS visits,
    COUNT(*) FILTER (WHERE event = 'paired') AS paired,
    ROUND(100.0 * COUNT(*) FILTER (WHERE event = 'paired') / NULLIF(COUNT(*) FILTER (WHERE event = 'visit'), 0), 1) AS pct
  FROM public.usage_events WHERE ${since} AND event IN ('visit', 'paired')
  GROUP BY 1 ORDER BY visits DESC`);

query("Time from opening to paired", `
  SELECT props->>'wait' AS wait, COUNT(*) AS paired
  FROM public.usage_events WHERE ${since} AND event = 'paired'
  GROUP BY 1 ORDER BY MIN(CASE props->>'wait' WHEN '<30s' THEN 1 WHEN '30s-2m' THEN 2 WHEN '2-10m' THEN 3 ELSE 4 END)`);

query("Pair types", `
  SELECT props->>'pair' AS pair, props->>'os' AS os, (props->>'peer_ios')::boolean AS peer_ios, COUNT(*) AS paired
  FROM public.usage_events WHERE ${since} AND event = 'paired'
  GROUP BY 1, 2, 3 ORDER BY paired DESC`);

query("Transfers", `
  SELECT props->>'kind' AS kind, props->>'from' AS sent_from, props->>'pair' AS pair, props->>'size' AS size,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE props->>'outcome' = 'ok') AS ok,
    COUNT(*) FILTER (WHERE props->>'outcome' = 'failed') AS failed,
    COUNT(*) FILTER (WHERE props->>'outcome' = 'cancelled') AS cancelled,
    ROUND(100.0 * COUNT(*) FILTER (WHERE props->>'outcome' = 'ok') / COUNT(*), 1) AS ok_pct
  FROM public.usage_events WHERE ${since} AND event = 'transfer'
  GROUP BY 1, 2, 3, 4 ORDER BY total DESC`);
