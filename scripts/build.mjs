#!/usr/bin/env node
/**
 * Build pipeline for cnproxy (Node.js).
 *
 *   1. Regenerate the embedded UI assets module (src/web/ui-assets.ts).
 *   2. Bundle bin/cnproxy.ts → dist/cnproxy.cjs with esbuild (single self-contained CJS file).
 *   3. (optional) Compile native single-file binaries for each platform with @yao-pkg/pkg.
 *
 * Usage:
 *   node scripts/build.mjs            # bundle only (dist/cnproxy.cjs)
 *   node scripts/build.mjs --pkg      # bundle + native binaries for all targets
 *   node scripts/build.mjs --pkg --targets node22-macos-arm64
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const bundle = join(distDir, "cnproxy.cjs");

const DEFAULT_TARGETS = [
  "node22-macos-arm64",
  "node22-macos-x64",
  "node22-linux-x64",
  "node22-linux-arm64",
  "node22-win-x64",
].join(",");

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

async function main() {
  const argv = process.argv.slice(2);
  mkdirSync(distDir, { recursive: true });

  // 1. embed UI
  run("node", ["scripts/embed-ui.mjs"]);

  // 2. esbuild bundle → single CJS
  await build({
    entryPoints: [join(root, "bin", "cnproxy.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: false,
    sourcemap: false,
    // node-forge + ws are bundled in; nothing stays external.
    banner: { js: "#!/usr/bin/env node" },
  });
  console.log(`Bundled → ${bundle}`);

  // 3. optional native binaries
  if (argv.includes("--pkg")) {
    const ti = argv.indexOf("--targets");
    const targets = ti !== -1 && argv[ti + 1] ? argv[ti + 1] : DEFAULT_TARGETS;
    run("npx", ["--yes", "@yao-pkg/pkg", bundle, "--targets", targets, "--out-path", distDir]);
    console.log(`Native binaries → ${distDir} (targets: ${targets})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
