/**
 * guuey open — Open a console page in the browser.
 *
 * Usage:
 *   guuey open              # Opens the app dashboard
 *   guuey open playground   # Opens the playground
 *   guuey open settings     # Opens account settings
 *   guuey open connectors   # Opens connectors page
 *   guuey open billing      # Opens billing page
 *   guuey open sessions     # Opens sessions page
 */

import { execFile } from 'node:child_process';
import { resolveConfig } from '../config';
import * as out from '../output';

const PAGES: Record<string, string> = {
  dashboard: '',
  app: '',
  playground: '/playground',
  settings: '/settings',
  billing: '/billing',
  usage: '/usage',
  sessions: '/sessions',
  design: '/design',
  analytics: '/analytics',
};

function openBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', [url]);
  } else if (platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url]);
  } else {
    execFile('xdg-open', [url]);
  }
}

/**
 * Handle the `guuey open [page]` command.
 * Opens a ggui console page in the default browser.
 *
 * @param page - Page name to open (e.g., `'dashboard'`, `'playground'`, `'settings'`).
 *   Defaults to `'dashboard'` if not specified.
 */
export function open(page?: string): void {
  const config = resolveConfig();
  const endpoint = config.host!; // Always set — DEFAULT_ENDPOINT fallback

  const target = page ?? 'dashboard';
  const path = PAGES[target];

  if (path === undefined) {
    out.error(`Unknown page: "${target}". Available: ${Object.keys(PAGES).join(', ')}`);
    process.exit(1);
  }

  // If page needs an app context and we have appId, use it
  const appId = config.appId;
  let url: string;

  if (target === 'dashboard' || target === 'settings' || target === 'billing' ||
      target === 'usage' || target === 'playground') {
    url = `${endpoint}${path}`;
  } else if (appId) {
    url = `${endpoint}/apps/${appId}${path}`;
  } else {
    url = `${endpoint}${path}`;
  }

  console.log(`Opening ${url}`);
  openBrowser(url);
}
