/* eslint-disable no-console */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { getConfigDir, getUpdateCacheFile } from './paths';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const NPM_REGISTRY = 'https://registry.npmjs.org/@guuey/cli';
const TIMEOUT_MS = 3000; // don't slow down the CLI

interface CacheData {
  lastCheck: number;
  latestVersion: string | null;
}

function readCache(): CacheData | null {
  try {
    return JSON.parse(readFileSync(getUpdateCacheFile(), 'utf-8')) as CacheData;
  } catch {
    return null;
  }
}

function writeCache(data: CacheData): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(getUpdateCacheFile(), JSON.stringify(data));
  } catch { /* ignore write errors */ }
}

/**
 * Check npm registry for a newer version. Non-blocking, cached daily.
 * Returns the latest version string if an update is available, null otherwise.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  const cache = readCache();

  // Use cached result if checked recently
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    if (cache.latestVersion && cache.latestVersion !== currentVersion) {
      return isNewer(cache.latestVersion, currentVersion) ? cache.latestVersion : null;
    }
    return null;
  }

  // Fetch latest version from npm (with timeout)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(NPM_REGISTRY, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      writeCache({ lastCheck: Date.now(), latestVersion: null });
      return null;
    }

    const data = (await res.json()) as { 'dist-tags'?: { latest?: string } };
    const latest = data['dist-tags']?.latest ?? null;

    writeCache({ lastCheck: Date.now(), latestVersion: latest });

    if (latest && latest !== currentVersion && isNewer(latest, currentVersion)) {
      return latest;
    }
  } catch {
    // Network error, timeout, etc. — don't block the CLI
    writeCache({ lastCheck: Date.now(), latestVersion: null });
  }

  return null;
}

/** Simple semver comparison: is `a` newer than `b`? */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/** Print update notice if a new version is available. */
export function printUpdateNotice(latestVersion: string, currentVersion: string): void {
  console.log(`\n  \x1b[33mUpdate available: ${currentVersion} → ${latestVersion}\x1b[0m`);
  console.log(`  Run: \x1b[1mcurl -fsSL https://guuey.com/install.sh | bash\x1b[0m\n`);
}
