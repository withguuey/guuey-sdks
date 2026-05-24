/**
 * Centralized CLI path helpers.
 *
 * Config/cache/auth all live under `~/.guuey`. Legacy `~/.ggui` directories
 * are migrated on first read, so users upgrading from the old CLI keep their
 * config + PAT seamlessly.
 */

import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NEW_DIRNAME = '.guuey';
const LEGACY_DIRNAME = '.ggui';

let migrated = false;

/**
 * Return the CLI config directory (`~/.guuey`).
 *
 * On first call, if only the legacy `~/.ggui` directory exists, it is renamed
 * to `~/.guuey`. Subsequent calls skip the check.
 */
export function getConfigDir(): string {
  const newDir = join(homedir(), NEW_DIRNAME);
  if (migrated) return newDir;

  const legacyDir = join(homedir(), LEGACY_DIRNAME);
  if (!existsSync(newDir) && existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, newDir);
    } catch {
      // If rename fails (e.g. cross-device), fall back silently — the caller
      // will create the new dir and the old one is left in place for now.
    }
  }
  migrated = true;
  return newDir;
}

/** Path to the auth token file inside the config dir. */
export function getAuthFile(): string {
  return join(getConfigDir(), 'auth.json');
}

/** Path to the global CLI config file inside the config dir. */
export function getGlobalConfigFile(): string {
  return join(getConfigDir(), 'config.json');
}

/** Path to the update-check cache file inside the config dir. */
export function getUpdateCacheFile(): string {
  return join(getConfigDir(), 'update-check.json');
}
