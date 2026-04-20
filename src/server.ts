import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import https from "https";
import { execSync, spawn } from "child_process";
import type {
  TeamInfo,
  TeamInfoCache,
  TeamSpendResponse,
  TeamDashboardResponse,
  TokenSource,
  CodexAuth,
  CodexQuotaWindow,
  CodexUsageResponse,
  CodexTokenSource,
  UpdateCheckResponse,
  UpdateInstallResponse,
  AutoStartResponse,
} from "./types";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// ---------------------------------------------------------------------------
// Session token resolution (auto-detected from Cursor's local SQLite DB)
// ---------------------------------------------------------------------------

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
  return getTokenFromDB();
}

function resolveTokenSource(): TokenSource {
  return getTokenFromDB() ? "local-db" : "none";
}

// ---------------------------------------------------------------------------
// Codex auth resolution (~/.codex/auth.json)
// ---------------------------------------------------------------------------

const CODEX_AUTH_PATH = path.join(
  process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"),
  "auth.json"
);

function readCodexAuth(): CodexAuth | null {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
    const accessToken: string = raw?.tokens?.access_token || "";
    const accountId: string = raw?.tokens?.account_id || "";
    if (!accessToken || !accountId) return null;

    const parts = accessToken.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64").toString("utf-8")
      );
      if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
        console.error("[codex] access_token expired");
        return null;
      }
    }

    return { accessToken, accountId };
  } catch (err: any) {
    console.error("[codex] failed to read auth.json:", err.message);
    return null;
  }
}

function resolveCodexTokenSource(): CodexTokenSource {
  return readCodexAuth() ? "codex-auth" : "none";
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

// ---------------------------------------------------------------------------
// Codex usage API
// ---------------------------------------------------------------------------

function parseCodexQuotaWindow(
  name: string,
  raw: any
): CodexQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;

  // The API nests some windows under a `primary_window` sub-key
  const w =
    typeof raw.primary_window === "object" && raw.primary_window
      ? raw.primary_window
      : raw;

  const percentLeft =
    w.percent_left ?? w.remaining_percent ?? (w.used_percent != null ? Math.max(0, 100 - Number(w.used_percent)) : null);
  const resetRaw = w.reset_time_ms ?? w.reset_at;
  const windowSeconds = w.limit_window_seconds ?? null;

  if (percentLeft == null) return null;

  let resetAt = "";
  if (resetRaw != null) {
    const ts = Number(resetRaw);
    // Heuristic: values > 10^11 are likely milliseconds, otherwise seconds
    const ms = ts > 1e11 ? ts : ts * 1000;
    resetAt = new Date(ms).toISOString();
  }

  return {
    percentLeft: Number(percentLeft),
    resetAt,
    windowSeconds: windowSeconds != null ? Number(windowSeconds) : name === "five_hour" ? 18000 : 604800,
  };
}

function parseCodexUsage(data: any): CodexUsageResponse {
  const rateLimits =
    (typeof data?.rate_limit === "object" && data.rate_limit) ||
    (typeof data?.rate_limits === "object" && data.rate_limits) ||
    data;

  let fiveHour: CodexQuotaWindow | null = null;
  let weekly: CodexQuotaWindow | null = null;

  for (const key of ["five_hour", "five_hour_limit", "five_hour_rate_limit", "primary"]) {
    if (rateLimits[key]) {
      fiveHour = parseCodexQuotaWindow("five_hour", rateLimits[key]);
      if (fiveHour) break;
    }
  }
  if (!fiveHour && rateLimits.primary_window) {
    fiveHour = parseCodexQuotaWindow("five_hour", rateLimits.primary_window);
  }

  for (const key of ["weekly", "weekly_limit", "weekly_rate_limit", "secondary"]) {
    if (rateLimits[key]) {
      weekly = parseCodexQuotaWindow("weekly", rateLimits[key]);
      if (weekly) break;
    }
  }
  if (!weekly && rateLimits.secondary_window) {
    weekly = parseCodexQuotaWindow("weekly", rateLimits.secondary_window);
  }

  // If window durations are present, use them to correct mis-labeled windows
  if (fiveHour && weekly) {
    if (fiveHour.windowSeconds >= 6 * 24 * 3600 && weekly.windowSeconds <= 6 * 3600) {
      [fiveHour, weekly] = [weekly, fiveHour];
    }
  }

  return { fiveHour, weekly };
}

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function fetchChatGPTUsage(auth: CodexAuth): any {
  const raw = execSync(
    `curl -s -m 20 -H "Authorization: Bearer ${auth.accessToken}" ` +
      `-H "Accept: application/json" ` +
      `-H "ChatGPT-Account-Id: ${auth.accountId}" ` +
      `-H "Origin: https://chatgpt.com" ` +
      `-H "Referer: https://chatgpt.com/" ` +
      `-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" ` +
      `"${CHATGPT_USAGE_URL}"`,
    { encoding: "utf-8", timeout: 25_000 }
  );
  return JSON.parse(raw);
}

app.get("/api/codex/usage", async (_req: Request, res: Response) => {
  const auth = readCodexAuth();
  if (!auth)
    return res.status(401).json({ error: "No Codex auth found in ~/.codex/auth.json" });

  try {
    const data = fetchChatGPTUsage(auth);
    res.json(parseCodexUsage(data));
  } catch (err: any) {
    console.error("[codex/usage]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Codex local token totals (from ~/.codex/state_5.sqlite)
// ---------------------------------------------------------------------------

function getCodexLocalTokens(): { totalTokens: number; sessions: number } {
  const codexHome =
    process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex");
  const dbPath = path.join(codexHome, "state_5.sqlite");

  if (!fs.existsSync(dbPath)) return { totalTokens: 0, sessions: 0 };

  try {
    try {
      const Database = require("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          "SELECT COUNT(*) as cnt, COALESCE(SUM(tokens_used), 0) as total FROM threads"
        )
        .get() as { cnt: number; total: number };
      db.close();
      return { totalTokens: row.total, sessions: row.cnt };
    } catch {
      const sqlite3Bin =
        process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
      const raw = execSync(
        `${sqlite3Bin} "${dbPath}" "SELECT COUNT(*) || ',' || COALESCE(SUM(tokens_used), 0) FROM threads"`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const [cnt, total] = raw.split(",").map(Number);
      return { totalTokens: total || 0, sessions: cnt || 0 };
    }
  } catch (err: any) {
    console.error("[codex/tokens] failed to read state DB:", err.message);
    return { totalTokens: 0, sessions: 0 };
  }
}

app.get("/api/codex/tokens", (_req: Request, res: Response) => {
  res.json(getCodexLocalTokens());
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get("/api/status", (_req: Request, res: Response) => {
  const token = resolveToken();
  const codexSource = resolveCodexTokenSource();
  const platforms: string[] = ["cursor"];
  if (codexSource !== "none") platforms.push("codex");
  res.json({
    hasToken: !!token,
    tokenSource: resolveTokenSource(),
    codexTokenSource: codexSource,
    platforms,
  });
});

// ---------------------------------------------------------------------------
// Team info resolution (shared by on-demand tokens + team-dashboard)
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

// ---------------------------------------------------------------------------
// On-demand token totals (from usage events API)
// ---------------------------------------------------------------------------

app.get("/api/cursor/on-demand-tokens", async (_req: Request, res: Response) => {
  const token = resolveToken();
  if (!token)
    return res.status(401).json({ error: "No Cursor session token configured" });

  try {
    const info = await getTeamInfo(token);
    if (!info.isTeamMember || !info.teamId) {
      return res.json({ onDemandTokens: 0 });
    }

    const userId = token.split("%3A%3A")[0];
    const usageData = await cursorGet("https://cursor.com/api/usage", token, {
      user: userId,
    });
    const cycleStartISO = usageData.startOfMonth || new Date(
      new Date().getFullYear(), new Date().getMonth(), 1
    ).toISOString();
    const cycleStartMs = new Date(cycleStartISO).getTime();

    const data = await cursorPost(
      "https://cursor.com/api/dashboard/get-filtered-usage-events",
      token,
      {
        teamId: info.teamId,
        startTime: cycleStartISO,
        endTime: "now",
        pageSize: 1000,
      }
    );

    const events: any[] = data.usageEventsDisplay || [];
    let onDemandTokens = 0;
    for (const e of events) {
      if (e.kind !== "USAGE_EVENT_KIND_USAGE_BASED") continue;
      // The API doesn't reliably filter by startTime, so filter client-side
      const ts = Number(e.timestamp);
      const eventMs = ts > 1e12 ? ts : ts * 1000;
      if (eventMs < cycleStartMs) continue;
      const tu = e.tokenUsage;
      if (!tu) continue;
      onDemandTokens +=
        (tu.inputTokens || 0) +
        (tu.outputTokens || 0) +
        (tu.cacheWriteTokens || 0) +
        (tu.cacheReadTokens || 0);
    }

    res.json({ onDemandTokens });
  } catch (err: any) {
    console.error("[cursor/on-demand-tokens]", err.message);
    res.json({ onDemandTokens: 0 });
  }
});

// ---------------------------------------------------------------------------
// Team usage API
// ---------------------------------------------------------------------------

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
// App lifecycle: update check / install + auto-start toggle
// ---------------------------------------------------------------------------

const PKG_JSON_PATH = path.join(__dirname, "..", "package.json");
const PKG_JSON: { version: string; repository?: { url?: string } | string } =
  JSON.parse(fs.readFileSync(PKG_JSON_PATH, "utf-8"));

function repoSlug(): string {
  const repo: any = PKG_JSON.repository;
  const url = typeof repo === "string" ? repo : repo?.url || "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/);
  return m ? m[1] : "kr4t0n/tokenomics";
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  const pb = b.split(/[.-]/).map((x) => (isNaN(+x) ? x : +x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = (pa[i] ?? 0) as number;
    const y = (pb[i] ?? 0) as number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": `tokenomics/${PKG_JSON.version}`,
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
              reject(e as Error);
            }
          });
        }
      )
      .on("error", reject);
  });
}

app.get("/api/update/check", async (_req: Request, res: Response) => {
  const slug = repoSlug();
  try {
    const remote = await fetchJson(
      `https://raw.githubusercontent.com/${slug}/main/package.json`
    );
    const latest = remote.version || null;
    const updateAvailable =
      !!latest && compareSemver(PKG_JSON.version, latest) < 0;
    const out: UpdateCheckResponse = {
      current: PKG_JSON.version,
      latest,
      updateAvailable,
      repo: slug,
    };
    res.json(out);
  } catch (err: any) {
    const out: UpdateCheckResponse = {
      current: PKG_JSON.version,
      latest: null,
      updateAvailable: false,
      repo: slug,
      error: err.message,
    };
    res.json(out);
  }
});

app.post("/api/update/install", async (_req: Request, res: Response) => {
  const slug = repoSlug();
  const child = spawn(
    "npm",
    ["install", "-g", `github:${slug}`, "--force"],
    { env: process.env }
  );

  let output = "";
  child.stdout.on("data", (d: Buffer) => {
    output += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    output += d.toString();
  });

  child.on("error", (err: Error) => {
    const out: UpdateInstallResponse = {
      ok: false,
      output: output + `\n${err.message}`,
      exitCode: null,
      error: err.message,
    };
    res.status(500).json(out);
  });

  child.on("close", (code: number | null) => {
    const out: UpdateInstallResponse = {
      ok: code === 0,
      output,
      exitCode: code,
    };
    res.status(code === 0 ? 200 : 500).json(out);
  });
});

// Auto-start needs Electron's app API (only available when this server is
// embedded in the menubar process, not when run as standalone Node).
const IS_ELECTRON = !!(process.versions as any).electron;

function loadConfigModule(): typeof import("./config") | null {
  if (!IS_ELECTRON) return null;
  try {
    return require("./config") as typeof import("./config");
  } catch {
    return null;
  }
}

app.get("/api/autostart", (_req: Request, res: Response) => {
  const cfg = loadConfigModule();
  if (!cfg) {
    const out: AutoStartResponse = { enabled: false, supported: false };
    return res.json(out);
  }
  const enabled = cfg.getLoginItemSettings().openAtLogin;
  const out: AutoStartResponse = { enabled, supported: true };
  res.json(out);
});

app.post("/api/autostart", express.json(), (req: Request, res: Response) => {
  const cfg = loadConfigModule();
  if (!cfg) {
    return res
      .status(400)
      .json({ error: "Auto-start is only available in the menubar app" });
  }
  const enable = !!req.body?.enabled;
  cfg.applyLoginItem(enable);
  const out: AutoStartResponse = { enabled: enable, supported: true };
  res.json(out);
});

// ---------------------------------------------------------------------------
// Start (only when run directly, not when required as a module)
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    const token = resolveToken();
    const codex = readCodexAuth();
    console.log(`\n  Tokenomics dashboard → http://localhost:${PORT}`);
    console.log(
      `  Cursor token: ${token ? "found (auto-detected)" : "⚠ not found — ensure Cursor is installed"}`
    );
    console.log(
      `  Codex auth:   ${codex ? "found (~/.codex/auth.json)" : "⚠ not found — run 'codex login' to authenticate"}`
    );
    console.log();
  });
}

export default app;
