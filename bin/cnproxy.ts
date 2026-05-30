#!/usr/bin/env node
/**
 * cnproxy CLI.
 *
 *   cnproxy [start]              start the proxy + web inspector (default)
 *   cnproxy ca                   print the root CA path / fingerprint
 *   cnproxy ca --export <file>   write the root CA cert to <file>
 *
 * Common flags: --port -p, --web-port -w, --host, --no-decrypt, --upstream -u,
 *   --rules <file>, --ignore <hosts>, --allow <hosts>, --quiet -q, --verbose -v,
 *   --open, --no-web, --version, --help
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ProxyServer, WebInspector, setLogLevel } from "../src/index.ts";
import { log } from "../src/logger.ts";

const HELP = `cnproxy — modern HTTP/HTTPS/WebSocket debugging proxy (Node.js)

Usage:
  cnproxy [start] [options]      Start proxy + web inspector
  cnproxy ca [--export <file>]   Show or export the root CA certificate

Options:
  -p, --port <n>        Proxy listen port            (default 8888)
  -w, --web-port <n>    Web inspector port           (default 8889)
      --host <addr>     Listen address               (default 127.0.0.1)
      --no-decrypt      Tunnel HTTPS without MITM decryption
  -u, --upstream <url>  Chain through an upstream proxy (http://host:port)
      --rules <file>    Load rule file
      --ignore <hosts>  Comma-separated hosts to never decrypt
      --allow <hosts>   Comma-separated allow-list of hosts to decrypt
      --no-web          Do not start the web inspector
      --open            Open the inspector in your browser
  -q, --quiet           Errors only
  -v, --verbose         Debug logging
      --version         Print version
  -h, --help            This help

Trust the CA once so HTTPS decrypts cleanly:
  cnproxy ca --export ~/cnproxy-ca.crt   (then add it to your system/browser trust store)
  or open  http://127.0.0.1:8889/ca.crt  while running.
`;

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      "web-port": { type: "string", short: "w" },
      host: { type: "string" },
      "no-decrypt": { type: "boolean", default: false },
      upstream: { type: "string", short: "u" },
      rules: { type: "string" },
      ignore: { type: "string" },
      allow: { type: "string" },
      "no-web": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      version: { type: "boolean", default: false },
      export: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(getVersion() + "\n");

  const cmd = positionals[0] ?? "start";

  if (values.quiet) setLogLevel("error");
  else if (values.verbose) setLogLevel("debug");

  if (cmd === "ca") return caCommand(values.export);
  if (cmd !== "start") {
    log.error(`unknown command: ${cmd}`);
    process.stdout.write(HELP);
    process.exit(1);
  }

  const rulesText = values.rules && existsSync(values.rules) ? readFileSync(values.rules, "utf8") : "";

  const proxy = new ProxyServer({
    host: values.host ?? "127.0.0.1",
    port: values.port ? parseInt(values.port, 10) : 8888,
    webPort: values["web-port"] ? parseInt(values["web-port"], 10) : 8889,
    decryptHttps: !values["no-decrypt"],
    upstream: values.upstream ?? null,
    rules: rulesText,
    ignoreHosts: splitList(values.ignore),
    allowHosts: splitList(values.allow),
  });

  await proxy.start();

  let web: WebInspector | undefined;
  if (!values["no-web"]) {
    web = new WebInspector(proxy);
    try {
      web.start();
    } catch {
      web = undefined;
      log.debug("Web inspector failed to start");
    }
    if (web && values.open) openBrowser(`http://${proxy.options.get("webHost")}:${web.port}`);
  }

  // Machine-readable ready signal for Tauri sidecar integration
  process.stdout.write(`[cnproxy:ready] ${JSON.stringify({ proxyPort: proxy.port, webPort: web?.port ?? 0 })}\n`);

  log.banner(`\nSet your client/system HTTP(S) proxy to ${proxy.options.get("host")}:${proxy.port}`);
  log.banner(`Trust the CA: open http://${proxy.options.get("webHost")}:${web?.port ?? proxy.options.get("webPort")}/ca.crt\n`);

  const shutdown = async () => {
    log.info("shutting down…");
    web?.stop();
    await proxy.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function caCommand(exportPath?: string) {
  const { CertificateAuthority } = await import("../src/cert/ca.ts");
  const { DEFAULT_OPTIONS } = await import("../src/options.ts");
  const ca = new CertificateAuthority(DEFAULT_OPTIONS.dataDir);
  await ca.init();
  if (exportPath) {
    writeFileSync(exportPath, readFileSync(ca.rootCertPath));
    log.banner(`Root CA exported → ${exportPath}`);
  } else {
    process.stdout.write(`Root CA: ${ca.rootCertPath}\n`);
    process.stdout.write(ca.rootCertPem + "\n");
  }
}

function splitList(v?: string): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const { spawn } = require("node:child_process");
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort */
  }
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
