import {
  app as electronApp,
  Menu,
  Notification,
  nativeImage,
  shell,
} from "electron";
import { menubar, Menubar } from "menubar";
import path from "path";
import { execSync } from "child_process";
import expressApp from "./server";
import {
  readUserConfig,
  applyLoginItem,
  getLoginItemSettings,
} from "./config";
import type {
  TeamDashboardResponse,
  CursorUsageResponse,
  UpdateCheckResponse,
  UpdateInstallResponse,
} from "./types";

const PORT = 47836;
const PKG_JSON: { version: string; repository?: { url?: string } | string } =
  require(path.join(__dirname, "..", "package.json"));
const REPO_URL = (() => {
  const repo: any = PKG_JSON.repository;
  const url = typeof repo === "string" ? repo : repo?.url || "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?/);
  return m ? `https://github.com/${m[1]}` : "https://github.com";
})();

let mb: Menubar;
let refreshInterval: ReturnType<typeof setInterval>;
let updateCheckInterval: ReturnType<typeof setInterval>;
let updateState: UpdateCheckResponse = {
  current: PKG_JSON.version,
  latest: null,
  updateAvailable: false,
  repo: "",
};
let installInProgress = false;

electronApp.setName("tokenomics");
electronApp.dock?.hide();

const argv = process.argv.slice(1);
if (argv.includes("--enable-autostart")) {
  applyLoginItem(true);
  console.log("[menubar] auto-start enabled");
  electronApp.exit(0);
}
if (argv.includes("--disable-autostart")) {
  applyLoginItem(false);
  console.log("[menubar] auto-start disabled");
  electronApp.exit(0);
}

const gotLock = electronApp.requestSingleInstanceLock();
if (!gotLock) {
  electronApp.quit();
}

electronApp.whenReady().then(() => {
  try {
    execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {
    // no process on the port — fine
  }

  const cfg = readUserConfig();
  if (cfg.autoStart) {
    applyLoginItem(true);
  }

  const server = expressApp.listen(PORT, () => {
    console.log(`[menubar] API server on port ${PORT}`);
  });
  server.on("error", (err: Error) => {
    console.error(`[menubar] Failed to start server: ${err.message}`);
    electronApp.quit();
  });

  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64," +
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAK" +
      "NJREFUWEft1kEKwCAMRNH0/oduF0KhxpiZSbqQrIT8p6JW55xb8arF+Y8AlAV2t7vf" +
      "r7e+bzcAyQKiAEkCVAEpAnQCEgRYBEQL8AiIFOATECXAKyBCQISASAFxArwC0AKQAu" +
      "IFeAWgBWQI8ApAC8gS4BWAFpApwCsALSBbgFcAWkAJArwC0AJKEeATgBZQkgCfALSA" +
      "0gT4BKAF/F3AD7YpMCFDCyaqAAAAAElFTkSuQmCC"
  );
  icon.setTemplateImage(true);

  mb = menubar({
    index: `http://localhost:${PORT}/menubar.html`,
    icon,
    preloadWindow: true,
    browserWindow: {
      width: 320,
      height: 200,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    },
    showDockIcon: false,
    showOnAllWorkspaces: false,
  });

  mb.on("ready", () => {
    console.log("[menubar] ready");
    updateTrayTitle();
    refreshInterval = setInterval(updateTrayTitle, 60_000);

    mb.tray.on("right-click", () => {
      mb.tray.popUpContextMenu(buildContextMenu());
    });

    // Background update check on startup, then every 6 hours.
    refreshUpdateState();
    updateCheckInterval = setInterval(refreshUpdateState, 6 * 60 * 60 * 1000);
  });

  mb.on("after-show", () => {
    mb.window?.webContents.send("refresh");
    resizeToFit();
  });

  function resizeToFit(): void {
    if (!mb.window) return;
    mb.window.webContents
      .executeJavaScript(`document.body.scrollHeight`)
      .then((h: number) => {
        mb.window!.setSize(320, Math.min(Math.max(h + 8, 100), 700));
      })
      .catch(() => {});
  }

  electronApp.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (_ev, _level, msg) => {
      if (msg === "__resize__") resizeToFit();
    });
  });
});

// ---------------------------------------------------------------------------
// Context menu (right-click on tray icon)
// ---------------------------------------------------------------------------

function buildContextMenu(): Menu {
  const autoStartEnabled = getLoginItemSettings().openAtLogin;
  const updateLabel = installInProgress
    ? "Installing update..."
    : updateState.updateAvailable && updateState.latest
      ? `Install update v${updateState.latest}`
      : "Check for updates";

  return Menu.buildFromTemplate([
    {
      label: `tokenomics v${PKG_JSON.version}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Refresh",
      click: () => {
        updateTrayTitle();
        mb.window?.webContents.reload();
      },
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: autoStartEnabled,
      click: (item) => applyLoginItem(item.checked),
    },
    { type: "separator" },
    {
      label: updateLabel,
      enabled: !installInProgress,
      click: () => {
        if (updateState.updateAvailable) {
          installUpdate();
        } else {
          checkUpdateAndNotify();
        }
      },
    },
    {
      label: "Open repository on GitHub",
      click: () => shell.openExternal(REPO_URL),
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "Cmd+Q",
      click: () => electronApp.quit(),
    },
  ]);
}

function notify(title: string, body: string): void {
  try {
    new Notification({ title, body }).show();
  } catch (err) {
    console.error("[menubar] notification failed:", (err as Error).message);
  }
}

async function refreshUpdateState(): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/update/check`);
    if (!res.ok) return;
    updateState = (await res.json()) as UpdateCheckResponse;
  } catch (err) {
    console.error("[menubar] update check failed:", (err as Error).message);
  }
}

async function checkUpdateAndNotify(): Promise<void> {
  try {
    await refreshUpdateState();
    if (updateState.updateAvailable && updateState.latest) {
      notify(
        "tokenomics: update available",
        `v${updateState.current} → v${updateState.latest}. Right-click the menu bar icon to install.`
      );
    } else {
      notify(
        "tokenomics is up to date",
        `You're on v${updateState.current}.`
      );
    }
  } catch (err) {
    notify("tokenomics: update check failed", (err as Error).message);
  }
}

async function installUpdate(): Promise<void> {
  if (installInProgress) return;
  installInProgress = true;
  notify(
    "tokenomics: updating",
    `Installing v${updateState.latest}... this can take ~30 seconds.`
  );

  try {
    const res = await fetch(`http://localhost:${PORT}/api/update/install`, {
      method: "POST",
    });
    const data = (await res.json()) as UpdateInstallResponse;
    if (data.ok) {
      notify(
        "tokenomics updated",
        `Installed v${updateState.latest}. Run \`tokenomics restart\` (or quit and relaunch) to apply.`
      );
      // Refresh state so menu shows current version next open. The actual
      // running process keeps the old code in memory until restart.
      await refreshUpdateState();
    } else {
      notify(
        "tokenomics: update failed",
        `npm exited with code ${data.exitCode}. Try \`tokenomics update\` from the terminal.`
      );
    }
  } catch (err) {
    notify("tokenomics: update failed", (err as Error).message);
  } finally {
    installInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Tray title (periodic refresh)
// ---------------------------------------------------------------------------

async function updateTrayTitle(): Promise<void> {
  try {
    const teamRes = await fetch(
      `http://localhost:${PORT}/api/cursor/team-dashboard`
    );
    if (teamRes.ok) {
      const team = (await teamRes.json()) as TeamDashboardResponse;
      if (team.isTeamMember && team.pricingStrategy === "tokens") {
        const spend =
          ((team.includedSpendCents || 0) + (team.spendCents || 0)) / 100;
        mb?.tray?.setTitle(` $${spend.toFixed(2)}`);
        return;
      }
    }

    const [usageRes, odRes] = await Promise.all([
      fetch(`http://localhost:${PORT}/api/cursor/usage`),
      fetch(`http://localhost:${PORT}/api/cursor/on-demand-tokens`),
    ]);
    if (!usageRes.ok) return;
    const data = (await usageRes.json()) as CursorUsageResponse;
    let tokens = 0;
    for (const [key, val] of Object.entries(data)) {
      if (key === "startOfMonth") continue;
      if (
        val &&
        typeof val === "object" &&
        typeof (val as any).numTokens === "number"
      ) {
        tokens += (val as any).numTokens;
      }
    }
    if (odRes.ok) {
      const od = (await odRes.json()) as { onDemandTokens?: number };
      tokens += od.onDemandTokens || 0;
    }
    let label: string;
    if (tokens >= 1_000_000_000)
      label = (tokens / 1_000_000_000).toFixed(1) + "B";
    else if (tokens >= 1_000_000)
      label = (tokens / 1_000_000).toFixed(1) + "M";
    else if (tokens >= 1_000) label = (tokens / 1_000).toFixed(1) + "K";
    else label = `${tokens}`;
    mb?.tray?.setTitle(` ${label} tokens`);
  } catch {
    mb?.tray?.setTitle("");
  }
}

electronApp.on("before-quit", () => {
  if (refreshInterval) clearInterval(refreshInterval);
  if (updateCheckInterval) clearInterval(updateCheckInterval);
});

electronApp.on("window-all-closed", () => {
  // Keep the menubar app alive when the popover closes.
});
