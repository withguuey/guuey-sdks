/**
 * CLI authentication — manages the `guuey_user_*` API key stored in
 * ~/.guuey/auth.json.
 *
 * Flow:
 *   1. `guuey login` opens browser to platform auth page
 *   2. User authenticates in the browser
 *   3. Platform mints a `guuey_user_*` API key — Cognito tokens stay in browser
 *   4. The key is sent to CLI's localhost callback
 *   5. CLI stores the key in ~/.guuey/auth.json
 *
 * The key is opaque; the server hash-verifies it and enforces the real expiry
 * on every request.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { getAuthFile, getConfigDir } from './paths';

export interface AuthTokens {
  /** Guuey API key (guuey_user_...) — opaque, server-verified. */
  pat: string;
  /** Token expiry (ISO string) */
  expiresAt: string;
  /** User's email */
  email?: string;
  /** User's ID */
  userId?: string;
}

/** CLI callback port — must be registered in the platform's allowed callback URLs */
export const CLI_CALLBACK_PORT = 21920;

/**
 * Load stored authentication tokens from `~/.guuey/auth.json`.
 */
export function loadAuth(): AuthTokens | null {
  const authFile = getAuthFile();
  if (!existsSync(authFile)) return null;
  try {
    return JSON.parse(readFileSync(authFile, 'utf-8')) as AuthTokens;
  } catch {
    return null;
  }
}

/**
 * Persist authentication tokens to `~/.guuey/auth.json`.
 * The file is created with mode `0o600` (owner read/write only).
 */
export function saveAuth(tokens: AuthTokens): void {
  const authDir = getConfigDir();
  const authFile = getAuthFile();
  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(authFile, JSON.stringify(tokens, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Delete the stored authentication file.
 */
export function clearAuth(): void {
  const authFile = getAuthFile();
  if (existsSync(authFile)) {
    unlinkSync(authFile);
  }
}

/**
 * The per-invocation key override — `GUUEY_API_KEY` (documented in
 * `cli.ts`'s env help) wins over the stored login for EVERY authenticated
 * command. Pre-guuey#182 only the legacy admin client honored it; the
 * cliApi command family read `requireAuth()` directly and silently sent
 * the stale stored PAT instead, so `GUUEY_API_KEY=… guuey apps list`
 * failed against a key that worked via curl. No local expiry check: the
 * value is opaque (a PAT or a Cognito bearer) and the server enforces the
 * real expiry on every request (see the module doc) — `expiresAt` here is
 * synthetic because callers only ever read `.pat`.
 */
function envKeyOverride(): AuthTokens | null {
  const key = process.env['GUUEY_API_KEY'];
  if (!key) return null;
  return { pat: key, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}

/**
 * Check if the user has a valid (non-expired) PAT. A `GUUEY_API_KEY`
 * override counts as logged in — otherwise commands that pre-check this
 * would force an interactive login the override was set to avoid.
 */
export function isLoggedIn(): boolean {
  if (envKeyOverride()) return true;
  const auth = loadAuth();
  if (!auth?.pat) return false;
  return new Date(auth.expiresAt) > new Date();
}

/**
 * Load and validate the PAT, throwing if not logged in or expired.
 * `GUUEY_API_KEY` wins over the stored login (see {@link envKeyOverride}).
 */
export function requireAuth(): AuthTokens {
  const override = envKeyOverride();
  if (override) return override;
  const auth = loadAuth();
  if (!auth?.pat) {
    throw new Error('Not logged in. Run: guuey login');
  }
  if (new Date(auth.expiresAt) <= new Date()) {
    throw new Error('Session expired. Run: guuey login');
  }
  return auth;
}
