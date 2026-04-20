#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * tokenomics CLI — launches the Electron menubar app, or runs a subcommand.
 *
 * Why this exists: shipping the project as a CLI (instead of a packaged
 * .app) avoids the need for an Apple Developer account / Gatekeeper
 * notarization. The Electron binary inside node_modules is already
 * signed by the Electron team, so macOS trusts it when launched as a
 * child process of the terminal.
 *
 * `tokenomics` (or `tokenomics start`) detaches Electron from the parent
 * shell by default so closing the terminal does not kill the menubar app.
 * Use `--foreground` / `-f` to keep it attached for debugging.
 */

const { spawn, spawnSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");

const PKG_ROOT = path.resolve(__dirname, "..");
const PKG_JSON = require(path.join(PKG_ROOT, "package.json"));
const REPO_SLUG =
  (PKG_JSON.repository && extractGithubSlug(PKG_JSON.repository)) ||
  "kr4t0n/tokenomics";

const APP_PORT = 47836;
const APP_DIR = path.join(process.env.HOME || "", ".tokenomics");
const LOG_FILE = path.join(APP_DIR, "tokenomics.log");

function extractGithubSlug(repo) {
  const url = typeof repo === "string" ? repo : repo.url || "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/);
  return m ? m[1] : null;
}

function printHelp() {
  console.log(`tokenomics v${PKG_JSON.version}

Usage:
  tokenomics                 Start the menubar app in the background (default).
  tokenomics start [-f]      Same. Pass --foreground / -f to keep it attached.
  tokenomics stop            Stop the running menubar app.
  tokenomics restart         Stop then start (useful after \`tokenomics update\`).
  tokenomics logs            Tail the menubar app's log file.
  tokenomics check           Check whether a newer version is on GitHub.
  tokenomics update          Pull and install the latest version from GitHub.
  tokenomics version         Print the installed version.
  tokenomics --help, -h      Show this help.

Logs:        ${LOG_FILE}
Repository:  https://github.com/${REPO_SLUG}
`);
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": `tokenomics-cli/${PKG_JSON.version}`,
            Accept: "application/json",
          },
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            fetchJson(res.headers.location).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            res.resume();
            return;
          }
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  const pb = b.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

async function checkForUpdate() {
  const url = `https://raw.githubusercontent.com/${REPO_SLUG}/main/package.json`;
  const remote = await fetchJson(url);
  const cmp = compareSemver(PKG_JSON.version, remote.version);
  return {
    current: PKG_JSON.version,
    latest: remote.version,
    updateAvailable: cmp < 0,
  };
}

async function cmdCheck() {
  try {
    const r = await checkForUpdate();
    if (r.updateAvailable) {
      console.log(
        `Update available: ${r.current} → ${r.latest}\nRun \`tokenomics update\` to install.`
      );
    } else {
      console.log(`tokenomics is up to date (v${r.current}).`);
    }
  } catch (err) {
    console.error(`Failed to check for updates: ${err.message}`);
    process.exit(1);
  }
}

function cmdUpdate() {
  console.log(`Installing latest tokenomics from github:${REPO_SLUG}...`);
  const result = spawnSync(
    "npm",
    ["install", "-g", `github:${REPO_SLUG}`, "--force"],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.error(
      `\nUpdate failed (exit ${result.status}). If you see a permission error,` +
        ` try installing with nvm so npm doesn't need root.`
    );
    process.exit(result.status ?? 1);
  }
  console.log(
    "\nUpdate installed. Run `tokenomics restart` to use the new version."
  );
}

// ---------------------------------------------------------------------------
// start / stop / restart / logs
// ---------------------------------------------------------------------------

function isAlreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: APP_PORT, path: "/api/status", timeout: 500 },
      (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getRunningPids() {
  try {
    const out = execSync(`lsof -ti:${APP_PORT}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? out.split("\n").map((s) => parseInt(s, 10)) : [];
  } catch {
    return [];
  }
}

async function cmdStart(args) {
  const foreground = args.includes("--foreground") || args.includes("-f");
  const electronBinary = require("electron");
  const entry = path.join(PKG_ROOT, "dist", "menubar.js");

  if (!fs.existsSync(entry)) {
    console.error(
      `Could not find ${entry}. Did you run \`npm run build\` (or install via npm)?`
    );
    process.exit(1);
  }

  if (await isAlreadyRunning()) {
    console.log(
      "tokenomics is already running. Click the menu bar icon, or run `tokenomics stop` to terminate."
    );
    return;
  }

  // Forward any non-flag args (e.g. --enable-autostart) to Electron.
  const passthrough = args.filter((a) => a !== "--foreground" && a !== "-f");

  if (foreground) {
    const child = spawn(electronBinary, [entry, ...passthrough], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      console.error(`Failed to launch Electron: ${err.message}`);
      process.exit(1);
    });
    return;
  }

  // Detached: fully decouple from the parent shell so closing the terminal
  // (or the user logging out) does not kill the menubar app.
  fs.mkdirSync(APP_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  const child = spawn(electronBinary, [entry, ...passthrough], {
    stdio: ["ignore", out, err],
    detached: true,
    env: process.env,
  });

  let spawnFailed = false;
  child.on("error", (e) => {
    spawnFailed = true;
    console.error(`Failed to launch Electron: ${e.message}`);
    process.exit(1);
  });

  // Give Electron a moment to fail synchronously (e.g. binary missing) before
  // we detach. If it survives 200ms we consider the spawn successful.
  setTimeout(() => {
    if (spawnFailed) return;
    child.unref();
    console.log(`tokenomics started in the background (pid ${child.pid}).`);
    console.log(`  Logs:  ${LOG_FILE}`);
    console.log(`  Stop:  tokenomics stop`);
    process.exit(0);
  }, 200);
}

function cmdStop() {
  const pids = getRunningPids();
  if (!pids.length) {
    console.log("tokenomics is not running.");
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (e) {
      console.error(`Failed to stop pid ${pid}: ${e.message}`);
    }
  }
  console.log(`Stopped tokenomics (pid ${pids.join(", ")}).`);
}

async function cmdRestart(args) {
  cmdStop();
  // Brief pause so the OS releases the port before we try to bind it again.
  await new Promise((r) => setTimeout(r, 500));
  await cmdStart(args.filter((a) => a !== "restart"));
}

function cmdLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log("No logs yet — start tokenomics first.");
    return;
  }
  const child = spawn("tail", ["-n", "50", "-f", LOG_FILE], {
    stdio: "inherit",
  });
  const exit = (code) => process.exit(code ?? 0);
  child.on("close", exit);
  process.on("SIGINT", () => {
    child.kill("SIGINT");
    exit(0);
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const cmd = (process.argv[2] || "start").toLowerCase();
const rest = process.argv.slice(3);

switch (cmd) {
  case "-h":
  case "--help":
  case "help":
    printHelp();
    break;
  case "version":
  case "-v":
  case "--version":
    console.log(PKG_JSON.version);
    break;
  case "check":
    cmdCheck();
    break;
  case "update":
    cmdUpdate();
    break;
  case "start":
    cmdStart(rest);
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdRestart(rest);
    break;
  case "logs":
    cmdLogs();
    break;
  default:
    // Allow `tokenomics --foreground` (no subcommand) to act as `start -f`.
    if (cmd.startsWith("-")) {
      cmdStart([cmd, ...rest]);
    } else {
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
    }
}
