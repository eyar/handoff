import fs from "node:fs";
import path from "node:path";

const publicDir = path.resolve("public");
const distDir = path.resolve("dist");
const buildDir = path.resolve("build");

// Copy public directory to both dist/ and build/ to ensure compatibility with all hosting presets
function copyFolder(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log("Building static site for deployment...");
copyFolder(publicDir, distDir);
copyFolder(publicDir, buildDir);
console.log("✓ Files copied to dist/ and build/ successfully.");
