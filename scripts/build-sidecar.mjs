#!/usr/bin/env node
/**
 * Build cnproxy sidecar binaries named for Tauri's externalBin convention:
 *   cnproxy-app/src-tauri/binaries/cnproxy-<rust-target-triple>[.exe]
 *
 * @yao-pkg/pkg cross-compiles (it fetches the prebuilt Node base binary for each target),
 * so any host can produce any of these — handy for a macOS universal app (arm64 + x64) and
 * for keeping CI to one job per OS.
 *
 * Usage:
 *   node scripts/build-sidecar.mjs                       # all triples for the host OS
 *   node scripts/build-sidecar.mjs <triple> [<triple>…]  # explicit Rust target triples
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const binDir = join(root, "cnproxy-app", "src-tauri", "binaries");

// Rust target triple → { pkg target, output extension }
const TRIPLES = {
  "aarch64-apple-darwin": { pkg: "node22-macos-arm64", ext: "" },
  "x86_64-apple-darwin": { pkg: "node22-macos-x64", ext: "" },
  "x86_64-unknown-linux-gnu": { pkg: "node22-linux-x64", ext: "" },
  "aarch64-unknown-linux-gnu": { pkg: "node22-linux-arm64", ext: "" },
  "x86_64-pc-windows-msvc": { pkg: "node22-win-x64", ext: ".exe" },
};

const HOST_DEFAULTS = {
  darwin: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu"],
  win32: ["x86_64-pc-windows-msvc"],
};

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

const requested = process.argv.slice(2);
const triples = requested.length ? requested : HOST_DEFAULTS[process.platform] ?? [];
if (!triples.length) {
  console.error(`No triples to build for platform ${process.platform}; pass them explicitly.`);
  process.exit(1);
}
for (const t of triples) {
  if (!TRIPLES[t]) {
    console.error(`Unknown Rust target triple: ${t}\nKnown: ${Object.keys(TRIPLES).join(", ")}`);
    process.exit(1);
  }
}

mkdirSync(binDir, { recursive: true });

// One pkg invocation builds every requested target into dist/.
const pkgTargets = triples.map((t) => TRIPLES[t].pkg).join(",");
run("node", [join("scripts", "build.mjs"), "--pkg", "--targets", pkgTargets]);

// pkg names a single-target output `cnproxy[.exe]`; a multi-target build appends the pkg
// target name, e.g. `cnproxy-macos-arm64`. Resolve whichever exists and copy to the triple name.
for (const triple of triples) {
  const { pkg, ext } = TRIPLES[triple];
  const arch = pkg.split("-").pop(); // node22-macos-arm64 → arm64
  const candidates = [
    join(distDir, `cnproxy-${arch}${ext}`), // multi-target name: cnproxy-arm64 / cnproxy-x64
    join(distDir, `cnproxy${ext}`), // single-target name
  ];
  const src = candidates.find((c) => existsSync(c));
  if (!src) {
    console.error(`pkg produced no binary for ${triple}; looked for:\n  ${candidates.join("\n  ")}`);
    process.exit(1);
  }
  const dest = join(binDir, `cnproxy-${triple}${ext}`);
  copyFileSync(src, dest);
  console.log(`Sidecar → ${dest}`);
}

// For macOS universal builds: lipo the two arch binaries into a fat universal binary.
// Tauri expects `cnproxy-universal-apple-darwin` when building --target universal-apple-darwin.
const macArm = "aarch64-apple-darwin";
const macX64 = "x86_64-apple-darwin";
if (triples.includes(macArm) && triples.includes(macX64) && platform === "darwin") {
  const arm = join(binDir, `cnproxy-${macArm}`);
  const x64 = join(binDir, `cnproxy-${macX64}`);
  const fat = join(binDir, "cnproxy-universal-apple-darwin");
  run("lipo", ["-create", "-output", fat, arm, x64]);
  console.log(`Universal → ${fat}`);
}
