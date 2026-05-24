/**
 * CLI authentication — manages PAT (Personal Access Token) stored in ~/.guuey/auth.json.
 *
 * Flow:
 *   1. `guuey login` opens browser to platform auth page
 *   2. User authenticates in the browser
 *   3. Platform generates a PAT (90-day, HMAC-signed) — auth tokens stay in browser
 *   4. PAT is sent to CLI's localhost callback
 *   5. CLI stores the PAT in ~/.guuey/auth.json
 *
 * The PAT is self-contained (no refresh needed) and valid for 90 days.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { getAuthFile, getConfigDir } from './paths';

export interface AuthTokens {
  /** CLI Personal Access Token (ggui_pat_...) */
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

/**
 * Decode a PAT payload (without verification — server verifies on each request).
 */
export function decodePatPayload(pat: string): Record<string, unknown> {
  if (!pat.startsWith('ggui_pat_')) throw new Error('Invalid PAT format');
  const stripped = pat.slice('ggui_pat_'.length);
  const dotIndex = stripped.lastIndexOf('.');
  if (dotIndex === -1) throw new Error('Invalid PAT format');
  const payloadStr = stripped.slice(0, dotIndex);
  return JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8')) as Record<string, unknown>;
}
