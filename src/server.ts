import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import type {
  Settings,
  TeamInfo,
  TeamInfoCache,
  TeamSpendResponse,
  TeamDashboardResponse,
  TokenSource,
} from "./types";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Persistent settings (~/.tokenomics/config.json)
// ---------------------------------------------------------------------------

const SETTINGS_DIR = path.join(process.env.HOME || "", ".tokenomics");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "config.json");

function readSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function writeSettings(settings: Settings): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getTokenFromSettings(): string {
  const s = readSettings();
  return s.cursorSessionToken || "";
}

// ---------------------------------------------------------------------------
// Session token resolution
// ---------------------------------------------------------------------------

function getTokenFromEnv(): string {
  return process.env.CURSOR_SESSION_TOKEN || "";
}

function getTokenFromDB(): string {
  const home = process.env.HOME || "";
  const dbPath =
    process.platform === "darwin"
      ? path.join(
          home,
          "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
        )
      : process.platform === "win32"
        ? path.join(
            process.env.APPDATA || "",
            "Cursor/User/globalStorage/state.vscdb"
          )
        : path.join(
            home,
            ".config/Cursor/User/globalStorage/state.vscdb"
          );

  if (!fs.existsSync(dbPath)) return "";

  try {
    let jwt: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get("cursorAuth/accessToken") as { value: Buffer | string } | undefined;
      db.close();
      if (!row) return "";
      jwt = row.value.toString().replace(/^"|"$/g, "");
    } catch (e1: any) {
      try {
        const sqlite3Bin =
          process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
        const raw = execSync(
          `${sqlite3Bin} "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        if (!raw) return "";
        jwt = raw.replace(/^"|"$/g, "");
      } catch (e2: any) {
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
    const sub: string = payload.sub || "";
    const userId = sub.includes("|") ? sub.split("|")[1] : sub;
    if (!userId) return "";
    return `${userId}%3A%3A${jwt}`;
  } catch (err: any) {
    console.error("[token] failed to read Cursor DB:", err.message);
    return "";
  }
}

function resolveToken(): string {
  return getTokenFromSettings() || getTokenFromEnv() || getTokenFromDB();
}

function resolveTokenSource(): TokenSource {
  if (getTokenFromSettings()) return "settings";
  if (getTokenFromEnv()) return "env";
  if (getTokenFromDB()) return "local-db";
  return "none";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = (token: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Cookie: `WorkosCursorSessionToken=${token}`,
  Origin: "https://cursor.com",
  Referer: "https://cursor.com/dashboard",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

async function cursorGet(
  url: string,
  token: string,
  params?: Record<string, string>
): Promise<any> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(url + qs, {
    headers: {
      Cookie: `WorkosCursorSessionToken=${token}`,
      "User-Agent": BROWSER_HEADERS(token)["User-Agent"],
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function cursorPost(
  url: string,
  token: string,
  body: Record<string, any> = {}
): Promise<any> {
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

app.get("/api/cursor/usage", async (_req: Request, res: Response) => {
  const token = resolveToken();
  if (!token)
    return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const userId = token.split("%3A%3A")[0];
    const data = await cursorGet("https://cursor.com/api/usage", token, {
      user: userId,
    });
    res.json(data);
  } catch (err: any) {
    console.error("[cursor/usage]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/invoice", async (req: Request, res: Response) => {
  const token = resolveToken();
  if (!token)
    return res.status(401).json({ error: "No Cursor session token configured" });

  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();

  try {
    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-monthly-invoice",
      token,
      { month, year, includeUsageEvents: false }
    );
    res.json(data);
  } catch (err: any) {
    console.error("[cursor/invoice]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/cursor/hard-limit", async (_req: Request, res: Response) => {
  const token = resolveToken();
  if (!token)
    return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-hard-limit",
      token,
      {}
    );
    res.json(data);
  } catch (err: any) {
    console.error("[cursor/hard-limit]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get(
  "/api/cursor/usage-based-status",
  async (_req: Request, res: Response) => {
    const token = resolveToken();
    if (!token)
      return res
        .status(401)
        .json({ error: "No Cursor session token configured" });

    try {
      const data = await cursorPost(
        "https://cursor.com/api/dashboard/get-usage-based-premium-requests",
        token,
        {}
      );
      res.json(data);
    } catch (err: any) {
      console.error("[cursor/usage-based-status]", err.message);
      res.status(502).json({ error: err.message });
    }
  }
);

app.get("/api/cursor/stripe-session", async (_req: Request, res: Response) => {
  const token = resolveToken();
  if (!token)
    return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const resp = await fetch("https://cursor.com/api/stripeSession", {
      headers: { Cookie: `WorkosCursorSessionToken=${token}` },
    });
    const text = await resp.text();
    res.json({ url: text.replace(/"/g, "") });
  } catch (err: any) {
    console.error("[cursor/stripe]", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/status", (_req: Request, res: Response) => {
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

app.get("/api/settings", (_req: Request, res: Response) => {
  const source = resolveTokenSource();
  const token = resolveToken();
  res.json({
    tokenSource: source,
    hasToken: !!token,
    maskedToken: token ? token.slice(0, 8) + "..." + token.slice(-4) : "",
  });
});

app.put("/api/settings/token", (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "Token is required" });
  }
  const settings = readSettings();
  settings.cursorSessionToken = token.trim();
  writeSettings(settings);
  res.json({ ok: true, tokenSource: "settings" });
});

app.delete("/api/settings/token", (_req: Request, res: Response) => {
  const settings = readSettings();
  delete settings.cursorSessionToken;
  writeSettings(settings);
  res.json({ ok: true, tokenSource: resolveTokenSource() });
});

// ---------------------------------------------------------------------------
// Team usage API
// ---------------------------------------------------------------------------

let _teamInfoCache: TeamInfoCache = { tokenKey: "", data: null, ts: 0 };
const TEAM_CACHE_TTL = 5 * 60 * 1000;

async function getTeamInfo(token: string): Promise<TeamInfo> {
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
  const teams: any[] = teamsRes.teams || [];
  if (!teams.length) {
    const result: TeamInfo = { isTeamMember: false };
    _teamInfoCache = { tokenKey, data: result, ts: Date.now() };
    return result;
  }

  const team = teams[0];
  const teamDetail = await cursorPost(
    "https://cursor.com/api/dashboard/team",
    token,
    { teamId: team.id }
  );

  const result: TeamInfo = {
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

app.get("/api/cursor/team-dashboard", async (_req: Request, res: Response) => {
  const token = resolveToken();
  if (!token) return res.json({ isTeamMember: false } as TeamDashboardResponse);

  try {
    const info = await getTeamInfo(token);
    if (!info.isTeamMember)
      return res.json({ isTeamMember: false } as TeamDashboardResponse);

    const spend: TeamSpendResponse = await cursorPost(
      "https://cursor.com/api/dashboard/get-team-spend",
      token,
      { teamId: info.teamId }
    );
    const userSpend =
      spend.teamMemberSpend?.find((m) => m.userId === info.userId);

    const response: TeamDashboardResponse = {
      isTeamMember: true,
      teamName: info.teamName,
      pricingStrategy: info.pricingStrategy,
      role: info.role,
      includedSpendCents: userSpend?.includedSpendCents || 0,
      spendCents: userSpend?.spendCents || 0,
      limitDollars: userSpend?.effectivePerUserLimitDollars || 0,
      cycleStart: spend.subscriptionCycleStart,
      cycleEnd: spend.nextCycleStart,
    };
    res.json(response);
  } catch (err: any) {
    console.error("[cursor/team-dashboard]", err.message);
    res.json({ isTeamMember: false } as TeamDashboardResponse);
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

export default app;
