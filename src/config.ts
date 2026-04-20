import path from "path";
import fs from "fs";
import { app as electronApp } from "electron";

/**
 * User-level config persisted at ~/.tokenomics/config.json.
 * Currently only stores the auto-start preference, but designed to
 * hold future per-user toggles (theme, refresh interval, etc.).
 */

export interface UserConfig {
  autoStart: boolean;
}

const DEFAULT_CONFIG: UserConfig = { autoStart: false };

function configDir(): string {
  return path.join(process.env.HOME || "", ".tokenomics");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function readUserConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeUserConfig(patch: Partial<UserConfig>): UserConfig {
  const merged = { ...readUserConfig(), ...patch };
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  } catch (err) {
    console.error("[config] failed to persist:", (err as Error).message);
  }
  return merged;
}

/**
 * Returns whether macOS currently has tokenomics registered as a login item.
 * In CLI-distribution mode, electron-app reports the registered exec path
 * which we don't strictly need; the boolean openAtLogin is what we surface.
 */
export function getLoginItemSettings(): { openAtLogin: boolean } {
  try {
    const s = electronApp.getLoginItemSettings();
    return { openAtLogin: !!s.openAtLogin };
  } catch {
    return { openAtLogin: false };
  }
}

/**
 * Register or unregister tokenomics as a macOS login item.
 *
 * In CLI mode `process.execPath` is the Electron binary inside
 * node_modules. macOS will run it with the bundled main script as
 * the entry point on next login. Path stability is OK as long as
 * the user doesn't move their global node_modules; reinstalling
 * via `tokenomics update` re-registers automatically.
 */
export function applyLoginItem(enable: boolean): void {
  try {
    if (enable) {
      electronApp.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: process.execPath,
        args: process.argv.slice(1).filter((a) => !a.startsWith("--enable-autostart") && !a.startsWith("--disable-autostart")),
      });
    } else {
      electronApp.setLoginItemSettings({ openAtLogin: false });
    }
    writeUserConfig({ autoStart: enable });
  } catch (err) {
    console.error("[config] applyLoginItem failed:", (err as Error).message);
  }
}
