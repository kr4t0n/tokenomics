# tokenomics

Dashboard to track token/request usage across AI coding platforms. Currently supports **Cursor** and **Codex**.

Runs as a macOS menu bar app (Electron tray) or as a standalone web dashboard.

## Features

- **Cursor**: request counts, on-demand spend vs. hard limit, team token-based billing
- **Codex**: 5-hour rolling quota and weekly quota (ChatGPT subscription)
- Auto-detects credentials from local app storage — no manual setup required for most users
- Periodic tray title updates showing current spend or token usage

## Prerequisites

- **Node.js** >= 18
- **Cursor** installed (for Cursor usage tracking)
- **Codex CLI** authenticated via `codex login` (for Codex usage tracking)

## Setup

```bash
git clone <repo-url>
cd tokenomics
npm install
```

## Usage

### Menu bar app (primary UX)

```bash
npm run menubar
```

Compiles TypeScript and launches the Electron tray app. The API server runs on port **47836** and the dashboard is served at `http://localhost:47836/menubar.html`.

### Standalone web dashboard

```bash
npm run build
node dist/server.js
```

Starts the Express server on `PORT` (default **3000**). Open `http://localhost:3000` in a browser.

### Package as macOS DMG

```bash
npm run dist
```

## Configuration

### Cursor

Token is **auto-detected** from Cursor's local SQLite database (`state.vscdb`). No manual configuration needed — just have Cursor installed and signed in.

### Codex

Token resolution:

- **Auto-detected** — read from `~/.codex/auth.json` (created by `codex login`)
- Respects `CODEX_HOME` environment variable for non-default install paths
- JWT expiry is validated before making API requests

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port for standalone server mode |
| `CODEX_HOME` | `~/.codex` | Override Codex config directory |

## Project Structure

```
tokenomics/
├── src/
│   ├── server.ts      # Express API server — token resolution, API proxying, routes
│   ├── menubar.ts     # Electron entry — tray icon, window management
│   └── types.ts       # Shared TypeScript interfaces
├── public/
│   └── menubar.html   # Single-page dashboard UI (Tailwind CSS)
├── package.json
└── tsconfig.json
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/cursor/usage` | GET | Cursor request/token counts per model |
| `/api/cursor/invoice` | GET | Monthly invoice breakdown |
| `/api/cursor/hard-limit` | GET | Spending hard limit |
| `/api/cursor/usage-based-status` | GET | Usage-based premium request status |
| `/api/cursor/stripe-session` | GET | Stripe billing portal URL |
| `/api/cursor/team-dashboard` | GET | Team spend and limits |
| `/api/codex/usage` | GET | Codex 5-hour and weekly quota |
| `/api/status` | GET | Token availability, sources, platforms |

## License

MIT
