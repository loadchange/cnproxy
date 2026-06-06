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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // npx resolves to npx.cmd on Windows; execFileSync won't append the extension, so use a shell there.
  const onWin = process.platform === "win32";
  const bin = onWin && cmd === "npx" ? "npx.cmd" : cmd;
  execFileSync(bin, args, { cwd: root, stdio: "inherit", shell: onWin });
}

async function main() {
  const argv = process.argv.slice(2);
  const doPkg = argv.includes("--pkg");
  mkdirSync(distDir, { recursive: true });

  // 1. embed UI
  run("node", ["scripts/embed-ui.mjs"]);

  // 2. esbuild bundle → single CJS.
  //    esbuild preserves the entry file's own `#!/usr/bin/env node` shebang, so we never add
  //    one via `banner` (doing so produced a duplicate shebang that broke `node dist/cnproxy.cjs`).
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
  });

  // Normalize to exactly one shebang. pkg chokes on a shebang inside its snapshot, so we strip
  // it before compiling and re-add a single one afterwards for `node dist/cnproxy.cjs` use.
  const SHEBANG = "#!/usr/bin/env node";
  const stripShebang = (s) => s.replace(/^(#![^\n]*\n)+/, "");
  let cjs = stripShebang(readFileSync(bundle, "utf8"));
  writeFileSync(bundle, doPkg ? cjs : SHEBANG + "\n" + cjs);
  console.log(`Bundled → ${bundle}`);

  // 3. optional native binaries
  if (doPkg) {
    const ti = argv.indexOf("--targets");
    const targets = ti !== -1 && argv[ti + 1] ? argv[ti + 1] : DEFAULT_TARGETS;
    run("npx", ["--yes", "@yao-pkg/pkg", bundle, "--targets", targets, "--out-path", distDir, "--fallback-to-source"]);
    console.log(`Native binaries → ${distDir} (targets: ${targets})`);

    // Re-add a single shebang to the CJS bundle so `node dist/cnproxy.cjs` still works.
    writeFileSync(bundle, SHEBANG + "\n" + cjs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});