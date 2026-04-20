# AGENTS.md

High-level context for AI agents working on this codebase.

## Architecture

The app has four layers:

1. **CLI wrapper** (`bin/tokenomics.js`) — tiny Node.js script registered as
   the package's `bin`. It is the entry point users run from a terminal. It
   either spawns Electron with the compiled `dist/menubar.js` or executes a
   subcommand (`update`, `check`, `version`, `--help`).
2. **Express API server** (`src/server.ts`) — the core. Resolves auth tokens,
   proxies external APIs, serves the dashboard UI as static files, and exposes
   app-lifecycle routes (`/api/update/*`, `/api/autostart`).
3. **Electron menubar** (`src/menubar.ts`) — imports the Express app, binds
   it to a fixed port (47836), wraps the dashboard in a macOS tray window,
   and applies the saved auto-start preference on launch.
4. **Dashboard UI** (`public/menubar.html`) — single HTML file with inline
   Tailwind CSS (CDN) and vanilla JavaScript. Calls the local API routes
   and renders usage bars only. **All settings and lifecycle controls live
   in the right-click tray menu** (built dynamically in `menubar.ts`); the
   popover has no gear button or settings panel.

The server can run standalone (Node) or embedded in Electron. The
`export default app` / `require.main === module` pattern enables both modes.
Electron-only code paths in `server.ts` are guarded by an `IS_ELECTRON` check
(`process.versions.electron`) so the standalone Node entry never tries to
import `electron`.

## Distribution Model

Shipped as an **npm CLI** rather than a packaged `.app`. This avoids
Apple Developer / Gatekeeper / notarization entirely:

- `npm install -g github:kr4t0n/tokenomics` installs the package globally
  and drops a `tokenomics` shim into the npm bin path. **There is no
  `postinstall` script** — it was removed because npm 10 + Node ≥ 22 crashes
  with `spawn sh ENOENT` while invoking lifecycle scripts inside Homebrew's
  `/opt/homebrew/lib/node_modules/...` prefix. Instead, `bin/tokenomics.js`
  lazily runs `tsc` on first launch (`ensureBuilt()`), and that work is
  cached in `dist/` for every subsequent invocation.
- `electron` and `typescript` are listed in **`dependencies`** (not
  `devDependencies`) because they are needed at runtime in a fresh global
  install.
- When the user runs `tokenomics`, the CLI launches Electron from
  `node_modules`. Because the Electron binary is signed by the Electron team
  and is being launched as a child of the user's terminal, macOS treats it as
  a trusted invocation — no Developer ID required.

### Self-update flow

`POST /api/update/install` (and `tokenomics update` on the CLI) shells out to
`npm install -g github:<repo> --force`. The repo slug is derived from
`package.json#repository`, falling back to `kr4t0n/tokenomics`.

`menubar.ts` polls `GET /api/update/check` on launch and every six hours,
caching the latest result in module-level state. The right-click tray menu
reads that state when it is opened: it shows **Check for updates** when no
update is known, **Install update vX.Y.Z** when one is available, and a
disabled **Installing update…** while a fetch is in flight. macOS
`Notification` is used for both "update available" and post-install status.

### Auto-start at login

`src/config.ts` wraps Electron's `app.setLoginItemSettings()` and persists
the user's choice to `~/.tokenomics/config.json` (`{ "autoStart": bool }`).
`src/menubar.ts` re-applies the saved preference on every launch so the
login item stays in sync if the user re-installs or moves the binary.

The CLI also accepts `--enable-autostart` / `--disable-autostart` flags so
users can toggle the login item without opening the UI.

## Platform Integration

### Cursor

- Token is auto-detected from Cursor's `state.vscdb` SQLite database — no manual configuration needed.
- Auto-detection reads the `cursorAuth/accessToken` JWT, decodes the `sub` claim to extract a userId, and constructs the `WorkosCursorSessionToken` cookie format.
- All Cursor API calls proxy to `cursor.com` with browser-like headers and cookies.
- On-demand token counts are fetched from `cursor.com/api/dashboard/get-filtered-usage-events`, which returns per-event token breakdowns. The server sums `inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens` for events where `kind == USAGE_EVENT_KIND_USAGE_BASED`, filtered client-side to the current billing cycle (the API's `startTime` parameter does not reliably filter).

### Codex

- Token source: auto-detect only, reads `~/.codex/auth.json` (created by `codex login`).
- The auth file contains `tokens.access_token` (JWT) and `tokens.account_id`.
- JWT `exp` claim is checked before making requests to avoid unnecessary calls with expired tokens.
- Usage data comes from ChatGPT's internal endpoint (`chatgpt.com/backend-api/wham/usage`), which returns rate limit quotas (5-hour rolling window + weekly limit) as percentage remaining.
- The API response field names are inconsistent across versions, so the server normalizes multiple possible key names (`five_hour`, `five_hour_limit`, `primary_window`, etc.) into a clean `CodexUsageResponse` shape.

## Key Design Decisions

- **CLI distribution over `.dmg`** — sidesteps the entire Apple notarization
  pipeline. Trade-off: users need Node.js installed.
- **Single HTML file for UI** — keeps packaging simple for Electron and avoids a build step for the frontend. Tailwind is loaded from CDN.
- **CommonJS modules** — required for Electron compatibility with the `menubar` package.
- **No manual token input for Codex** — the ChatGPT auth flow is browser-based and produces a JWT that auto-refreshes. Pasting tokens manually would be fragile.
- **Graceful degradation** — each platform section renders independently. If Codex auth is missing or the API is unreachable, only the Codex section hides; Cursor still works and vice versa.
- **Team info caching** — Cursor team info is cached for 5 minutes to reduce API calls.

## Conventions

- TypeScript strict mode, ES2022 target, CommonJS output.
- All API routes follow the pattern `/api/<platform>/<resource>` (or `/api/<feature>` for app-lifecycle routes).
- Error responses use `{ error: string }` with appropriate HTTP status codes (401 for missing auth, 502 for upstream failures).
- Shared types live in `src/types.ts`.

## Gotchas

- The `chatgpt.com/backend-api/wham/usage` endpoint is an internal/unofficial API. Its response shape has changed before — the normalization logic in `parseCodexUsage()` handles known variations but may need updating if OpenAI changes it again.
- Port 47836 is hardcoded in `menubar.ts`. The standalone server uses `PORT` env var (default 3000).
- `better-sqlite3` is a native module listed in **`optionalDependencies`** —
  if its prebuilt binary or compile step fails (architecture mismatch,
  Node-version mismatch, or the well-known `npm install -g` "spawn sh ENOENT"
  race against Homebrew-managed prefixes), npm continues installing the rest
  of the package and the server falls back to the `/usr/bin/sqlite3` CLI
  binary at runtime. Do NOT promote it back to `dependencies` without
  re-validating global installs on macOS.
- The Electron app kills anything on port 47836 at startup (`lsof -ti:PORT | xargs kill -9`).
- **`npm install -g` paths**: under nvm the global bin is per-version, so the
  user may need to re-run install after switching Node versions.
- **No `postinstall` script** — see "Distribution Model" above. If you ever
  add one back, re-test global installs against Homebrew's prefix to confirm
  it doesn't trip the `spawn sh ENOENT` race.
- **`github:` shorthand is broken on npm 10** — `npm install -g github:owner/repo`
  symlinks the global package to a temp git-clone in
  `~/.npm/_cacache/tmp/git-clone…/`, which npm then prunes, leaving a
  dangling symlink at `/opt/homebrew/lib/node_modules/<pkg>`. Install
  instructions, `cmdUpdate()` in `bin/tokenomics.js`, and the
  `POST /api/update/install` route therefore all use the tarball URL
  (`https://github.com/<slug>/tarball/main`) instead. Do not switch back to
  `github:` shorthand without re-validating.
- **First-launch latency**: `tokenomics start` invokes `tsc` once when
  `dist/menubar.js` is missing, which adds ~1–2 s to the very first launch.
  Subsequent launches skip the build.
- **Login item registration** uses the absolute path of the `tokenomics`
  shim. If the user moves/reinstalls the package, the registration is
  refreshed automatically on next launch via `applyLoginItem(cfg.autoStart)`.
- **`process.versions.electron` guard**: any code that imports from
  `electron` must be lazy-required behind an `IS_ELECTRON` check, otherwise
  the standalone Node mode will crash trying to load Electron's native
  bindings.
- **Magic console-message IPC**: the popover uses `console.log("__resize__")`
  to ask the main process to resize the window to its content. The Electron
  main process listens for this on `web-contents-created`. Keep this
  contract in sync if either side is refactored. (The `__quit__` channel was
  removed when settings moved to the right-click menu — quit is now native.)
- **Right-click tray menu owns ALL settings**: version label, refresh,
  start-at-login checkbox, update check/install, GitHub link, and quit are
  all built dynamically by `buildContextMenu()` in `menubar.ts`. Do NOT
  reintroduce gear/quit buttons in `menubar.html` — that creates two sources
  of truth and was deliberately removed.
- **Update notifications**: `refreshUpdateState()` runs on launch and every
  6 hours. `checkUpdateAndNotify()` always notifies (used by the menu);
  the background poll only notifies when the latest version changes.
- **Detached child by default**: `bin/tokenomics.js` spawns Electron with
  `detached: true` + `child.unref()` and pipes stdio to
  `~/.tokenomics/tokenomics.log`. A short `setTimeout` keeps the parent alive
  briefly so synchronous spawn errors are still surfaced before the parent
  exits. Use `--foreground` (or `-f`) for live logs.
- **Single-instance check via HTTP**: `tokenomics start` probes
  `http://localhost:47836/api/status` before spawning Electron. If the probe
  succeeds, the start command is a no-op and the existing instance keeps
  running. This complements Electron's `requestSingleInstanceLock()`.
- **`stop`/`restart` use port-based PID lookup**: the CLI runs
  `lsof -ti:47836` to find the running Electron process and sends `SIGTERM`.
  If a stale process holds the port without serving HTTP, `stop` is the
  recovery path.
