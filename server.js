const express = require("express");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Persistent settings (~/.tokenomics/config.json)
// ---------------------------------------------------------------------------

const SETTINGS_DIR = path.join(process.env.HOME || "", ".tokenomics");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "config.json");

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSettings(settings) {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getTokenFromSettings() {
  const s = readSettings();
  return s.cursorSessionToken || "";
}

// ---------------------------------------------------------------------------
// Session token resolution
// ---------------------------------------------------------------------------

function getTokenFromEnv() {
  return process.env.CURSOR_SESSION_TOKEN || "";
}

function getTokenFromDB() {
  const dbPath =
    process.platform === "darwin"
      ? path.join(
          process.env.HOME,
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
        )
      : process.platform === "win32"
        ? path.join(
            process.env.APPDATA,
            "Cursor/User/globalStorage/state.vscdb"
          )
        : path.join(
            process.env.HOME,
            ".config/Cursor/User/globalStorage/state.vscdb"
          );

  if (!fs.existsSync(dbPath)) return "";

  try {
    let jwt;
    try {
      const Database = require("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(
        "cursorAuth/accessToken"
      );
      db.close();
      if (!row) return "";
      jwt = row.value.toString().replace(/^"|"$/g, "");
    } catch (e1) {
      // Fallback: use sqlite3 CLI (ships with macOS / most Linux)
      try {
        const sqlite3Bin = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
        const raw = execSync(
          `${sqlite3Bin} "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        if (!raw) return "";
        jwt = raw.replace(/^"|"$/g, "");
      } catch (e2) {
        console.error("[token] better-sqlite3:", e1.message);
        console.error("[token] sqlite3 CLI:", e2.message);
        return "";
      }
    }

    // Decode the JWT to extract the userId from the `sub` claim,
    // then construct the WorkosCursorSessionToken format: userId%3A%3Ajwt
    const payloadB64 = jwt.split(".")[1];
    if (!payloadB64) return "";
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64").toString("utf-8")
    );
    const sub = payload.sub || "";
    const userId = sub.includes("|") ? sub.split("|")[1] : sub;
    if (!userId) return "";
    return `${userId}%3A%3A${jwt}`;
  } catch (err) {
    console.error("[token] failed to read Cursor DB:", err.message);
    return "";
  }
}

function resolveToken() {
  return getTokenFromSettings() || getTokenFromEnv() || getTokenFromDB();
}

function resolveTokenSource() {
  if (getTokenFromSettings()) return "settings";
  if (getTokenFromEnv()) return "env";
  if (getTokenFromDB()) return "local-db";
  return "none";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = (token) => ({
  "Content-Type": "application/json",
  Cookie: `WorkosCursorSessionToken=${token}`,
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

async function cursorGet(url, token, params) {
  const qs = params
    ? "?" + new URLSearchParams(params).toString()
    : "";
  const res = await fetch(url + qs, {
    headers: {
      Cookie: `WorkosCursorSessionToken=${token}`,
      "User-Agent": BROWSER_HEADERS(token)["User-Agent"],
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function cursorPost(url, token, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: BROWSER_HEADERS(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

app.get("/api/cursor/usage", async (_req, res) => {
  const token = resolveToken();
  if (!token) return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const userId = token.split("%3A%3A")[0];
    const data = await cursorGet("https://cursor.com/api/usage", token, { user: userId });
    res.json(data);
  } catch (err) {
    console.error("[cursor/usage]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/invoice", async (req, res) => {
  const token = resolveToken();
  if (!token) return res.status(401).json({ error: "No Cursor session token configured" });

  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();

  try {
    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-monthly-invoice",
      token,
      { month, year, includeUsageEvents: false }
    );
    res.json(data);
  } catch (err) {
    console.error("[cursor/invoice]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/hard-limit", async (_req, res) => {
  const token = resolveToken();
  if (!token) return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-hard-limit",
      token,
      {}
    );
    res.json(data);
  } catch (err) {
    console.error("[cursor/hard-limit]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/usage-based-status", async (_req, res) => {
  const token = resolveToken();
  if (!token) return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-usage-based-premium-requests",
      token,
      {}
    );
    res.json(data);
  } catch (err) {
    console.error("[cursor/usage-based-status]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/stripe-session", async (_req, res) => {
  const token = resolveToken();
  if (!token) return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const resp = await fetch("https://cursor.com/api/stripeSession", {
      headers: { Cookie: `WorkosCursorSessionToken=${token}` },
    });
    const text = await resp.text();
    res.json({ url: text.replace(/"/g, "") });
  } catch (err) {
    console.error("[cursor/stripe]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Health / token status
app.get("/api/status", (_req, res) => {
  const token = resolveToken();
  res.json({
    hasToken: !!token,
    tokenSource: resolveTokenSource(),
    platforms: ["cursor"],
  });
});

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

app.get("/api/settings", (_req, res) => {
  const source = resolveTokenSource();
  const token = resolveToken();
  res.json({
    tokenSource: source,
    hasToken: !!token,
    maskedToken: token ? token.slice(0, 8) + "..." + token.slice(-4) : "",
  });
});

app.put("/api/settings/token", (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "Token is required" });
  }
  const settings = readSettings();
  settings.cursorSessionToken = token.trim();
  writeSettings(settings);
  res.json({ ok: true, tokenSource: "settings" });
});

app.delete("/api/settings/token", (_req, res) => {
  const settings = readSettings();
  delete settings.cursorSessionToken;
  writeSettings(settings);
  res.json({ ok: true, tokenSource: resolveTokenSource() });
});

// ---------------------------------------------------------------------------
// Team usage API
// ---------------------------------------------------------------------------

let _teamInfoCache = { tokenKey: "", data: null, ts: 0 };
const TEAM_CACHE_TTL = 5 * 60 * 1000;

async function getTeamInfo(token) {
  const tokenKey = token.slice(0, 20);
  if (
    _teamInfoCache.tokenKey === tokenKey &&
    _teamInfoCache.data &&
    Date.now() - _teamInfoCache.ts < TEAM_CACHE_TTL
  ) {
    return _teamInfoCache.data;
  }

  const teamsRes = await cursorPost(
    "https://cursor.com/api/dashboard/teams",
    token,
    {}
  );
  const teams = teamsRes.teams || [];
  if (!teams.length) {
    const result = { isTeamMember: false };
    _teamInfoCache = { tokenKey, data: result, ts: Date.now() };
    return result;
  }

  const team = teams[0];
  const teamDetail = await cursorPost(
    "https://cursor.com/api/dashboard/team",
    token,
    { teamId: team.id }
  );

  const result = {
    isTeamMember: true,
    teamId: team.id,
    teamName: team.name,
    userId: teamDetail.userId,
    role: team.role,
    pricingStrategy: team.pricingStrategy || "requests",
    seats: team.seats,
  };
  _teamInfoCache = { tokenKey, data: result, ts: Date.now() };
  return result;
}

app.get("/api/cursor/team-dashboard", async (_req, res) => {
  const token = resolveToken();
  if (!token) return res.json({ isTeamMember: false });

  try {
    const info = await getTeamInfo(token);
    if (!info.isTeamMember) return res.json({ isTeamMember: false });

    const spend = await cursorPost(
      "https://cursor.com/api/dashboard/get-team-spend",
      token,
      { teamId: info.teamId }
    );
    const userSpend =
      spend.teamMemberSpend?.find((m) => m.userId === info.userId) || {};

    res.json({
      isTeamMember: true,
      teamName: info.teamName,
      pricingStrategy: info.pricingStrategy,
      role: info.role,
      includedSpendCents: userSpend.includedSpendCents || 0,
      spendCents: userSpend.spendCents || 0,
      limitDollars: userSpend.effectivePerUserLimitDollars || 0,
      cycleStart: spend.subscriptionCycleStart,
      cycleEnd: spend.nextCycleStart,
    });
  } catch (err) {
    console.error("[cursor/team-dashboard]", err.message);
    res.json({ isTeamMember: false });
  }
});

// ---------------------------------------------------------------------------
// Start (only when run directly, not when required as a module)
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    const token = resolveToken();
    console.log(`\n  Tokenomics dashboard → http://localhost:${PORT}`);
    console.log(
      `  Cursor token: ${token ? `found (${getTokenFromEnv() ? "env" : "local DB"})` : "⚠ not found — set CURSOR_SESSION_TOKEN in .env or ensure Cursor is installed"}`
    );
    console.log();
  });
}

module.exports = app;
