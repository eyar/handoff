// Builds the store upload zip for the browser extension: dist-extension/handoff-extension-<version>.zip
// The Chrome Web Store / Edge Add-ons assign their own extension ID, so the dev-only "key" is removed.
// After the first upload, add the store ID's origin to EXTENSION_ORIGINS in public/modules/constants.js.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const srcDir = path.resolve("extension");
const outDir = path.resolve("dist-extension");
const stageDir = path.join(outDir, "stage");

const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"));
delete manifest.key;

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });
fs.cpSync(srcDir, stageDir, {
  recursive: true,
  filter: (src) => !/STORE_LISTING\.md$|\.DS_Store$/.test(src),
});
fs.writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const zipPath = path.join(outDir, `handoff-extension-${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipPath, "."], { cwd: stageDir });
fs.rmSync(stageDir, { recursive: true, force: true });

console.log(`✓ ${path.relative(process.cwd(), zipPath)} (v${manifest.version}, no dev key)`);
