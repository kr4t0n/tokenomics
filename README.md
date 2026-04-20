# tokenomics

Dashboard to track token/request usage across AI coding platforms (Cursor, Codex).

Runs as a macOS menu bar app (Electron tray) without requiring any
code-signing or Apple Developer account — distributed as a `tokenomics` CLI
installed via npm/GitHub. The same Express server can also be run as a
standalone web dashboard.

## Features

- **Cursor**: request counts, on-demand spend vs. hard limit, on-demand token totals, team billing
- **Codex**: 5-hour rolling quota and weekly quota (ChatGPT subscription)
- Auto-detects credentials from local app storage — no manual setup required for most users
- Periodic tray title updates showing current spend or token usage
- Built-in **auto-start at login** toggle (macOS login items)
- Built-in **self-update** from GitHub (`tokenomics update` or right-click menu)
- Right-click menu for refresh, start-at-login toggle, update check/install, and quit

## Prerequisites

- **macOS** (the menu bar UI is macOS-only; the web dashboard is cross-platform)
- **Node.js** >= 18
- **Cursor** installed (for Cursor usage tracking)
- **Codex CLI** authenticated via `codex login` (for Codex usage tracking)

## Install

Install once with npm and the `tokenomics` command becomes globally available:

```bash
npm install -g github:kr4t0n/tokenomics
```

This installs a tiny CLI wrapper that launches an Electron menubar app from
`node_modules`. Because the Electron binary is already signed by the Electron
team, macOS Gatekeeper trusts it when launched as a child process of your
terminal — no developer certificate required.

You can also run it without installing:

```bash
npx github:kr4t0n/tokenomics
```

### From a local clone (development)

```bash
git clone https://github.com/kr4t0n/tokenomics.git
cd tokenomics
npm install
npm link            # exposes the `tokenomics` command globally
```

## Usage

### Menu bar app (default)

```bash
tokenomics            # same as `tokenomics start`
```

Launches the Electron tray app. The API server listens on port **47836** and
the dashboard is served at `http://localhost:47836/menubar.html`.

Click the menu bar icon to open the popover and view your usage. **Right-click**
the icon for all settings and lifecycle actions:

- **Refresh** — re-fetch usage data and reload the popover
- **Start at login** — toggle the macOS login item
- **Check for updates** / **Install update vX.Y.Z** — query GitHub and run
  `npm install -g github:<repo> --force` from inside the app
- **Open repository on GitHub**
- **Quit**

Update results are also surfaced via native macOS notifications.

### Background by default

`tokenomics start` (and the bare `tokenomics` invocation) detaches the
Electron process from the terminal so closing the shell does not kill the
menubar app. Its output is redirected to `~/.tokenomics/tokenomics.log`.

If the app is already running, `start` is a no-op (it probes
`http://localhost:47836/api/status` first).

To debug or watch logs live, run in the foreground:

```bash
tokenomics start --foreground   # or: tokenomics start -f
```

### Subcommands

| Command | Description |
|---------|-------------|
| `tokenomics` / `tokenomics start` | Launch the menubar app in the background |
| `tokenomics start -f` / `--foreground` | Launch attached to the terminal |
| `tokenomics stop` | Stop the running menubar app |
| `tokenomics restart` | Stop and relaunch the menubar app |
| `tokenomics logs` | Tail `~/.tokenomics/tokenomics.log` |
| `tokenomics check` | Check whether a newer version exists on GitHub |
| `tokenomics update` | Pull and install the latest version from GitHub |
| `tokenomics version` | Print the installed version |
| `tokenomics --help` | Show usage |

### Updating

Either run:

```bash
tokenomics update
tokenomics restart   # pick up the new version
```

…or right-click the menu bar icon and pick **Check for updates**. When a new
version exists, the menu shows **Install update vX.Y.Z**; selecting it runs
`npm install -g github:<repo> --force` and notifies you when finished. Then
quit from the same menu and relaunch (or run `tokenomics restart`).

The app also polls for updates in the background every six hours and posts
a macOS notification when a newer version is available.

### Auto-start at login

Toggle **Start at login** in the right-click menu. You can also control it
from the CLI:

```bash
tokenomics --enable-autostart
tokenomics --disable-autostart
```

This uses macOS login items via Electron's
`app.setLoginItemSettings()` and persists the choice in
`~/.tokenomics/config.json`.

### Standalone web dashboard

```bash
npm run build
node dist/server.js
```

Starts the Express server on `PORT` (default **3000**). Open
`http://localhost:3000` in a browser. Auto-start and self-update endpoints
are no-ops in this mode (they require Electron).

## Configuration

### Cursor

Token is **auto-detected** from Cursor's local SQLite database
(`state.vscdb`). No manual configuration needed — just have Cursor installed
and signed in.

### Codex

Token is **auto-detected** from `~/.codex/auth.json` (created by
`codex login`). Respects the `CODEX_HOME` environment variable for
non-default install paths. JWT expiry is validated before making API
requests.

### User config file

Stored at `~/.tokenomics/config.json`:

```json
{ "autoStart": false }
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port for standalone server mode |
| `CODEX_HOME` | `~/.codex` | Override Codex config directory |

## Project Structure

```
tokenomics/
├── bin/
│   └── tokenomics.js  # CLI wrapper that launches Electron
├── src/
│   ├── server.ts      # Express API server — token resolution, API proxying, routes
│   ├── menubar.ts     # Electron entry — tray icon, window management
│   ├── config.ts      # User config + macOS login item helpers
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
| `/api/cursor/on-demand-tokens` | GET | On-demand token count for current billing cycle |
| `/api/codex/usage` | GET | Codex 5-hour and weekly quota |
| `/api/codex/tokens` | GET | Codex monthly token totals |
| `/api/status` | GET | Token availability, sources, platforms, app version |
| `/api/update/check` | GET | Compare local version against GitHub `main` |
| `/api/update/install` | POST | Run `npm install -g github:<repo> --force` |
| `/api/autostart` | GET / POST | Read or toggle macOS login item (Electron only) |

## License

MIT
