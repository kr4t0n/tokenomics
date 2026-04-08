const { app: electronApp, nativeImage, Tray, Menu } = require("electron");
const { menubar } = require("menubar");
const path = require("path");
const { execSync } = require("child_process");
const expressApp = require("./server");

const PORT = 47836;
let mb;
let refreshInterval;

// Enforce single instance — quit duplicates, focus existing
const gotLock = electronApp.requestSingleInstanceLock();
if (!gotLock) {
  electronApp.quit();
}

electronApp.whenReady().then(() => {
  // Kill any stale process holding the port from a previous run
  try { execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { stdio: "ignore" }); } catch {}

  const server = expressApp.listen(PORT, () => {
    console.log(`[menubar] API server on port ${PORT}`);
  });
  server.on("error", (err) => {
    console.error(`[menubar] Failed to start server: ${err.message}`);
    electronApp.quit();
  });

  // 16x16 template icon (dark outline of a bar chart)
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
  });

  mb.on("after-show", () => {
    mb.window?.webContents.send("refresh");
    resizeToFit();
  });

  function resizeToFit() {
    if (!mb.window) return;
    mb.window.webContents.executeJavaScript(
      `document.body.scrollHeight`
    ).then((h) => {
      mb.window.setSize(320, Math.min(Math.max(h + 8, 100), 600));
    }).catch(() => {});
  }
});

async function updateTrayTitle() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/cursor/usage`);
    if (!res.ok) return;
    const data = await res.json();
    const gpt4 = data["gpt-4"] || {};
    const tokens = gpt4.numTokens || 0;
    let label;
    if (tokens >= 1_000_000_000) label = (tokens / 1_000_000_000).toFixed(1) + "B";
    else if (tokens >= 1_000_000) label = (tokens / 1_000_000).toFixed(1) + "M";
    else if (tokens >= 1_000) label = (tokens / 1_000).toFixed(1) + "K";
    else label = `${tokens}`;
    mb?.tray?.setTitle(` ${label} tokens`);
  } catch {
    mb?.tray?.setTitle("");
  }
}

electronApp.on("window-all-closed", (e) => e.preventDefault());
