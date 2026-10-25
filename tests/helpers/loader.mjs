import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";

// Node module hooks so browser modules and the Deno edge functions can
// be imported under `node --test` without a bundler or Deno runtime.
const stub = (name) => new URL(`../stubs/${name}`, import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  // public/modules/constants.js imports the deploy-time config by absolute path.
  if (specifier === "/config.js") {
    return { url: stub("config.js"), shortCircuit: true };
  }
  // Edge functions import Supabase and AWS SDK through Deno's npm: specifier.
  if (specifier.startsWith("npm:@supabase/supabase-js")) {
    return { url: stub("supabase.js"), shortCircuit: true };
  }
  if (specifier.startsWith("npm:@aws-sdk/")) {
    return { url: stub("s3.js"), shortCircuit: true };
  }
  // Importing session.js with ?faircap=on swaps in constants with the
  // paid fair-use cap switched on, so that branch can be exercised too.
  if (specifier === "./constants.js" && context.parentURL?.includes("faircap=on")) {
    return { url: stub("constants-faircap.js"), shortCircuit: true };
  }
  // computerBridge.js only needs the camera code under test; skip the
  // Supabase client, the realtime module graph and the UMD QR decoder.
  if (context.parentURL?.includes("/modules/computerBridge.js") &&
      ["./realtime.js", "./supabaseClient.js", "../vendor/jsqr/jsQR.mjs"].includes(specifier)) {
    return { url: stub("scanner-deps.js"), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// Load the TypeScript edge functions by stripping their types ourselves, so the
// tests do not depend on Node's built-in .ts support being switched on.
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  if (typeof nodeModule.stripTypeScriptTypes !== "function") {
    throw new Error(`Loading ${url} needs Node 22.13 or newer (running ${process.version}).`);
  }
  const source = await readFile(new URL(url), "utf8");
  return { format: "module", source: nodeModule.stripTypeScriptTypes(source), shortCircuit: true };
}
