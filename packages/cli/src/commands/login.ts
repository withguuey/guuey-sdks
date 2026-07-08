/**
 * guuey login — Browser-based authentication.
 *
 * Opens the platform's CLI auth page in the browser. The platform
 * authenticates the user, generates a PAT, and sends it to a
 * localhost callback.
 */

import * as http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from '../config';
import { CLI_CALLBACK_PORT, saveAuth, decodePatPayload, type AuthTokens } from '../auth';
import * as out from '../output';

/** Open a URL in the default browser (cross-platform). Returns false if no browser available. */
function openBrowser(url: string): boolean {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execFile('open', [url], () => {});
      return true;
    }
    if (platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], () => {});
      return true;
    }
    // Linux: check if xdg-open exists
    try {
      execFileSync('which', ['xdg-open'], { stdio: 'ignore' });
      execFile('xdg-open', [url], () => {});
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Handle the `guuey login` command.
 *
 * Two modes:
 * 1. **Browser auth** (default): Opens browser, generates PAT server-side,
 *    delivers to CLI via localhost callback.
 * 2. **Token auth** (`--token`): Accepts a pre-generated PAT for headless/CI.
 */
export async function login(flags: Record<string, string | true> = {}): Promise<void> {
  // --token flag: headless login with a pre-generated PAT
  const tokenValue = flags.token;
  if (tokenValue && typeof tokenValue === 'string') {
    // `guuey_user_*` is the cliApi-native API key (hash-verified server-side;
    // opaque to the client — no payload to decode, the server enforces the
    // row's real expiry). Store as-is with a nominal local expiry.
    if (tokenValue.startsWith('guuey_user_')) {
      saveAuth({
        pat: tokenValue,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      });
      out.success('Logged in with API key (server-side expiry applies)');
      return;
    }
    if (!tokenValue.startsWith('ggui_pat_')) {
      out.error(
        'Invalid token format. Token must start with "guuey_user_" (API key) or "ggui_pat_" (dashboard PAT).',
      );
      process.exit(1);
    }

    try {
      const payload = decodePatPayload(tokenValue);

      if (!payload.exp || (payload.exp as number) * 1000 < Date.now()) {
        out.error('Token has expired. Generate a new one from the dashboard.');
        process.exit(1);
      }

      saveAuth({
        pat: tokenValue,
        expiresAt: new Date((payload.exp as number) * 1000).toISOString(),
        email: payload.email as string | undefined,
        userId: payload.sub as string | undefined,
      });

      out.success(`Logged in as ${payload.email ?? payload.sub ?? 'unknown'}`);
    } catch {
      out.error('Invalid token. Generate a new one from the dashboard.');
      process.exit(1);
    }
    return;
  }

  const config = resolveConfig();
  const endpoint = config.host!;

  const state = randomBytes(16).toString('hex');
  const callbackUrl = `http://localhost:${CLI_CALLBACK_PORT}/callback`;

  const authUrl = `${endpoint}/cli/authorize?state=${state}&callback=${encodeURIComponent(callbackUrl)}`;

  // Start the callback server, then try to open browser
  const tokenPromise = waitForCallback(state);

  setTimeout(() => {
    const opened = openBrowser(authUrl);
    if (opened) {
      console.log('Opening browser for authentication...');
      console.log('If the browser doesn\'t open, copy this URL:\n');
    } else {
      console.log('Open this URL in your browser to authenticate:\n');
    }
    console.log(`  ${authUrl}\n`);
    console.log('Waiting for authentication...');
  }, 300);

  try {
    const tokens = await tokenPromise;
    saveAuth(tokens);

    // ggui_pat_ tokens carry decoded identity; guuey_user_ keys are opaque,
    // so there is no email/sub to print — say what we actually have.
    const identity = tokens.email ?? tokens.userId;
    if (identity) {
      out.success(`Logged in as ${identity}`);
    } else {
      out.success('Logged in with API key (server-side expiry applies)');
    }
  } catch (err) {
    out.error((err as Error).message);
    process.exit(1);
  }
}

/** Nominal local expiry for opaque keys — the server enforces the real one. */
const NOMINAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Build the stored auth record from a browser-callback body, mirroring the
 * `--token` path's prefix handling:
 *
 *   - `guuey_user_*` — the cliApi-native API key. Opaque to the client (no
 *     payload to decode); the server hash-verifies it and enforces the row's
 *     real expiry. Store the callback's `expiresAt` when it parses as a date,
 *     else a nominal +90d local expiry.
 *   - `ggui_pat_*` — the HMAC-signed dashboard PAT. Decode it for identity
 *     (`email`/`sub`) and expiry, preferring the callback's `expiresAt`.
 *
 * Returns `null` when the token carries neither prefix (the caller rejects it).
 */
export function tokensFromCallback(pat: string, expiresAt?: string): AuthTokens | null {
  if (pat.startsWith('guuey_user_')) {
    const parsed = expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? expiresAt : undefined;
    return {
      pat,
      expiresAt: parsed ?? new Date(Date.now() + NOMINAL_TTL_MS).toISOString(),
    };
  }
  if (pat.startsWith('ggui_pat_')) {
    const payload = decodePatPayload(pat);
    return {
      pat,
      expiresAt: expiresAt ?? new Date((payload.exp as number) * 1000).toISOString(),
      email: payload.email as string | undefined,
      userId: payload.sub as string | undefined,
    };
  }
  return null;
}

/**
 * Start a local HTTP server and wait for the token callback.
 */
function waitForCallback(expectedState: string): Promise<AuthTokens> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes. Try again.'));
    }, 5 * 60 * 1000);

    const MAX_BODY_SIZE = 16 * 1024;

    const server = http.createServer((req, res) => {
      const origin = req.headers.origin ?? '';
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://localhost:${CLI_CALLBACK_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      let body = '';
      let bodySize = 0;

      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > MAX_BODY_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
          req.destroy();
          return;
        }
        body += chunk.toString();
      });

      req.on('end', () => {
        if (bodySize > MAX_BODY_SIZE) return;

        try {
          const data = JSON.parse(body) as Record<string, string>;

          if (data.error) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Authentication failed: ${data.error}`));
            return;
          }

          if (data.state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid state' }));
            return;
          }

          const pat = data.pat;
          const tokens = pat ? tokensFromCallback(pat, data.expiresAt) : null;
          if (!tokens) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'Invalid token received (expected "guuey_user_" or "ggui_pat_" prefix)',
              }),
            );
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin || '*',
          });
          res.end(JSON.stringify({ ok: true }));
          clearTimeout(timeout);
          server.close();
          resolve(tokens);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CLI_CALLBACK_PORT} is already in use. Close the other process and try again.`));
      } else {
        reject(err);
      }
    });

    server.listen(CLI_CALLBACK_PORT);
  });
}
