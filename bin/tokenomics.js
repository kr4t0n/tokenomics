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
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");

const PKG_ROOT = path.resolve(__dirname, "..");
const PKG_JSON = require(path.join(PKG_ROOT, "package.json"));
const REPO_SLUG =
  (PKG_JSON.repository && extractGithubSlug(PKG_JSON.repository)) ||
  "kr4t0n/tokenomics";

function extractGithubSlug(repo) {
  const url = typeof repo === "string" ? repo : repo.url || "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/);
  return m ? m[1] : null;
}

function printHelp() {
  console.log(`tokenomics v${PKG_JSON.version}

Usage:
  tokenomics                Launch the menubar app (default).
  tokenomics start          Same as above.
  tokenomics update         Pull and install the latest version from GitHub.
  tokenomics check          Check whether a newer version is available.
  tokenomics version        Print the installed version.
  tokenomics --help, -h     Show this help.

Repository: https://github.com/${REPO_SLUG}
`);
}

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
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
      process.exit(0);
    } else {
      console.log(`tokenomics is up to date (v${r.current}).`);
      process.exit(0);
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
  console.log("\nUpdate installed. Relaunch tokenomics to use the new version.");
}

function cmdStart() {
  const electronBinary = require("electron");
  const entry = path.join(PKG_ROOT, "dist", "menubar.js");
  if (!fs.existsSync(entry)) {
    console.error(
      `Could not find ${entry}. Did you run \`npm run build\` (or install via npm)?`
    );
    process.exit(1);
  }
  const child = spawn(electronBinary, [entry, ...process.argv.slice(3)], {
    stdio: "inherit",
    detached: false,
    env: process.env,
  });
  child.on("close", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`Failed to launch Electron: ${err.message}`);
    process.exit(1);
  });
}

const cmd = (process.argv[2] || "start").toLowerCase();
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
    cmdStart();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
}
