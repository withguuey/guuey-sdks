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
 * Check if the user has a valid (non-expired) PAT.
 */
export function isLoggedIn(): boolean {
  const auth = loadAuth();
  if (!auth?.pat) return false;
  return new Date(auth.expiresAt) > new Date();
}

/**
 * Load and validate the PAT, throwing if not logged in or expired.
 */
export function requireAuth(): AuthTokens {
  const auth = loadAuth();
  if (!auth?.pat) {
    throw new Error('Not logged in. Run: guuey login');
  }
  if (new Date(auth.expiresAt) <= new Date()) {
    throw new Error('Session expired. Run: guuey login');
  }
  return auth;
}
