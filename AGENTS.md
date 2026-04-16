# AGENTS.md

High-level context for AI agents working on this codebase.

## Architecture

The app has three layers:

1. **Express API server** (`src/server.ts`) — the core. Resolves auth tokens, proxies external APIs, and serves the dashboard UI as static files.
2. **Electron menubar** (`src/menubar.ts`) — imports the Express app, binds it to a fixed port (47836), and wraps the dashboard in a macOS tray window.
3. **Dashboard UI** (`public/menubar.html`) — single HTML file with inline Tailwind CSS (CDN) and vanilla JavaScript. Calls the local API routes and renders usage bars.

The server can run standalone (Node) or embedded in Electron. The `export default app` / `require.main === module` pattern enables both modes.

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

- **Single HTML file for UI** — keeps packaging simple for Electron and avoids a build step for the frontend. Tailwind is loaded from CDN.
- **CommonJS modules** — required for Electron compatibility with the `menubar` package.
- **No manual token input for Codex** — the ChatGPT auth flow is browser-based and produces a JWT that auto-refreshes. Pasting tokens manually would be fragile.
- **Graceful degradation** — each platform section renders independently. If Codex auth is missing or the API is unreachable, only the Codex section hides; Cursor still works and vice versa.
- **Team info caching** — Cursor team info is cached for 5 minutes to reduce API calls.

## Conventions

- TypeScript strict mode, ES2022 target, CommonJS output.
- All API routes follow the pattern `/api/<platform>/<resource>`.
- Error responses use `{ error: string }` with appropriate HTTP status codes (401 for missing auth, 502 for upstream failures).
- Shared types live in `src/types.ts`.

## Gotchas

- The `chatgpt.com/backend-api/wham/usage` endpoint is an internal/unofficial API. Its response shape has changed before — the normalization logic in `parseCodexUsage()` handles known variations but may need updating if OpenAI changes it again.
- Port 47836 is hardcoded in `menubar.ts`. The standalone server uses `PORT` env var (default 3000).
- `better-sqlite3` is a native module — if it fails to load (e.g., architecture mismatch), the server falls back to the `sqlite3` CLI binary.
- The Electron app kills anything on port 47836 at startup (`lsof -ti:PORT | xargs kill -9`).