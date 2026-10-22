// Looking for a new version in the background, so the user hears about one
// without having to open Settings → About. The check is quiet: it asks the
// release manifest, remembers when it did, and never installs anything.
import { check } from "@tauri-apps/plugin-updater";
import { getAppPrefs, setAppPrefs } from "./settingsStore";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Whether it is time to look again: the setting is on (it is by default) and
// the last look was at least a day ago.
export function shouldCheck(now: number, lastCheck: number | undefined, enabled: boolean | undefined): boolean {
  if (enabled === false) return false;
  if (lastCheck === undefined) return true;
  // a clock that went backwards must not silence the check for good
  return now < lastCheck || now - lastCheck >= UPDATE_CHECK_INTERVAL_MS;
}

export interface AvailableUpdate {
  version: string;
  // true the first time this version is seen here, so a notification is sent once
  isNew: boolean;
}

// True when version `a` is newer than `b` (numeric, dot-separated; a pre-release
// suffix is ignored).
export function isNewerVersion(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

// The update an earlier check found, if it is still newer than the running app.
// No network: it lets the hint show right at start. Never throws.
export async function knownUpdate(currentVersion: string): Promise<string | null> {
  try {
    const found = (await getAppPrefs())?.availableUpdateVersion;
    return found && isNewerVersion(found, currentVersion) ? found : null;
  } catch {
    return null;
  }
}

// Checks if it is due. Resolves to the new version, or null (up to date, not
// due, switched off, or the manifest couldn't be fetched — which is not
// something to bother the user with). Never throws.
export async function checkForUpdateQuietly(now: number = Date.now()): Promise<AvailableUpdate | null> {
  try {
    const prefs = await getAppPrefs();
    if (!shouldCheck(now, prefs?.lastUpdateCheck, prefs?.autoUpdateCheck)) return null;
    const update = await check();
    await setAppPrefs({ lastUpdateCheck: now, availableUpdateVersion: update?.version ?? "" });
    if (!update) return null;
    const isNew = prefs?.notifiedUpdateVersion !== update.version;
    if (isNew) await setAppPrefs({ notifiedUpdateVersion: update.version });
    return { version: update.version, isNew };
  } catch {
    return null;
  }
}
