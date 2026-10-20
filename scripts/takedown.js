#!/usr/bin/env node
// Removes reported content from storage right away, without waiting for the 15-minute expiry.
//
//   npm run takedown -- "<reported link>"          deletes every file in that link's room
//   npm run takedown -- "<reported link>" --file   deletes only the linked file
//   npm run takedown -- abc123def4                 a room ID works too
//
// Accepts a file download link (…r2.cloudflarestorage.com/…/<room>/<file>?X-Amz-…), an app link
// (handoffdrop.app/?room=<room>) or a bare 10-character room ID. Several can be passed at once.

const PROD_URL = "https://kljzghiiovsvymixqgrf.supabase.co";
const PROD_KEY = "sb_publishable_CrO5DO9HYvrCJUrkow24AQ_uB14CVX2";
const ROOM_RE = /^[a-z0-9]{10}$/;

const args = process.argv.slice(2);
const fileOnly = args.includes("--file");
const targets = args.filter((a) => a !== "--file");

function parseTarget(raw) {
  const value = raw.trim();
  if (ROOM_RE.test(value)) return { room: value };
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const roomParam = (url.searchParams.get("room") || "").toLowerCase();
  if (ROOM_RE.test(roomParam)) return { room: roomParam };
  // Storage links: /<bucket>/<room>/<file> or, on a bucket subdomain, /<room>/<file>
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const i = segments.findIndex((s) => ROOM_RE.test(s));
  if (i === -1) return null;
  const file = segments.slice(i + 1).join("/");
  return { room: segments[i], path: file ? `${segments[i]}/${file}` : undefined };
}

async function sign(body) {
  const res = await fetch(`${PROD_URL}/functions/v1/r2-sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: PROD_KEY, Authorization: `Bearer ${PROD_KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

if (targets.length === 0) {
  console.log('Usage: npm run takedown -- "<reported link or room ID>" [--file]');
  process.exit(1);
}

let failed = false;
for (const raw of targets) {
  const target = parseTarget(raw);
  if (!target) {
    console.error(`✗ Couldn't find a room in: ${raw}`);
    failed = true;
    continue;
  }
  try {
    if (fileOnly) {
      if (!target.path) throw new Error("--file needs a file download link, not a room");
      const { count } = await sign({ action: "delete", roomId: target.room, paths: [target.path] });
      console.log(`✓ ${new Date().toISOString()}  deleted file ${target.path} (${count} removed)`);
    } else {
      const { count } = await sign({ action: "delete-room", roomId: target.room });
      console.log(`✓ ${new Date().toISOString()}  deleted room ${target.room}: ${count} file(s) removed${count === 0 ? " (already expired)" : ""}`);
    }
  } catch (err) {
    console.error(`✗ ${raw}: ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
