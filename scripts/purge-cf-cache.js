import fs from "node:fs";
import path from "node:path";

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

const token = getEnv("CLOUDFLARE_API_TOKEN");
const zoneId = getEnv("CLOUDFLARE_ZONE_ID");

if (!token || !zoneId) {
  console.error("Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID in .env");
  process.exit(1);
}

try {
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ purge_everything: true })
  });

  const data = await res.json();
  if (data.success) {
    console.log("✓ Cloudflare edge cache purged successfully!");
  } else {
    console.error("Purge failed:", data.errors);
  }
} catch (err) {
  console.error("Error purging Cloudflare cache:", err.message);
}
