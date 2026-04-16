import { app as electronApp, Menu, nativeImage } from "electron";
import { menubar, Menubar } from "menubar";
import path from "path";
import { execSync } from "child_process";
import expressApp from "./server";
import type { TeamDashboardResponse, CursorUsageResponse } from "./types";

const PORT = 47836;
let mb: Menubar;
let refreshInterval: ReturnType<typeof setInterval>;

const gotLock = electronApp.requestSingleInstanceLock();
if (!gotLock) {
  electronApp.quit();
}

electronApp.whenReady().then(() => {
  try {
    execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {}

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

    const contextMenu = Menu.buildFromTemplate([
      { label: "Refresh", click: () => { updateTrayTitle(); mb.window?.webContents.reload(); } },
      { type: "separator" },
      { label: "Quit", click: () => electronApp.quit() },
    ]);
    mb.tray.on("right-click", () => {
      mb.tray.popUpContextMenu(contextMenu);
    });
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
      if (val && typeof val === "object" && typeof (val as any).numTokens === "number") {
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

electronApp.on("window-all-closed", () => {
  // Prevent default quit — keep the menubar app alive
});
