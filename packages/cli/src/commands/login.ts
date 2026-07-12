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
import { CLI_CALLBACK_PORT, saveAuth, type AuthTokens } from '../auth';
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
 * 1. **Browser auth** (default): Opens browser, mints a `guuey_user_*` API key
 *    server-side, delivers it to the CLI via localhost callback.
 * 2. **Token auth** (`--token`): Accepts a pre-minted `guuey_user_*` API key
 *    for headless/CI use.
 */
export async function login(flags: Record<string, string | true> = {}): Promise<void> {
  // --token flag: headless login with a pre-minted API key
  const tokenValue = flags.token;
  if (tokenValue && typeof tokenValue === 'string') {
    // `guuey_user_*` is the cliApi-native API key (hash-verified server-side;
    // opaque to the client — no payload to decode, the server enforces the
    // row's real expiry). Store as-is with a nominal local expiry.
    if (!tokenValue.startsWith('guuey_user_')) {
      out.error(
        'Invalid token format. Token must start with "guuey_user_" (a Guuey API key from the dashboard).',
      );
      process.exit(1);
    }
    saveAuth({
      pat: tokenValue,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });
    out.success('Logged in with API key (server-side expiry applies)');
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

    // guuey_user_ keys are opaque — there is no email/sub to print.
    out.success('Logged in with API key (server-side expiry applies)');
  } catch (err) {
    out.error((err as Error).message);
    process.exit(1);
  }
}

/** Nominal local expiry for opaque keys — the server enforces the real one. */
const NOMINAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Build the stored auth record from a browser-callback body.
 *
 * The platform delivers a `guuey_user_*` API key: opaque to the client (no
 * payload to decode); the server hash-verifies it and enforces the row's real
 * expiry. Store the callback's `expiresAt` when it parses as a date, else a
 * nominal +90d local expiry.
 *
 * Returns `null` when the token does not carry the `guuey_user_` prefix (the
 * caller rejects it).
 */
export function tokensFromCallback(pat: string, expiresAt?: string): AuthTokens | null {
  if (pat.startsWith('guuey_user_')) {
    const parsed = expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? expiresAt : undefined;
    return {
      pat,
      expiresAt: parsed ?? new Date(Date.now() + NOMINAL_TTL_MS).toISOString(),
    };
  }
  return null;
}

/**
 * Start a local HTTP server and wait for the token callback.
 *
 * Exported for the PNA regression test (`login.test.ts`) — the browser
 * page that opens `authUrl` runs on a public origin while this callback
 * server is localhost, so Chrome's Local-Network-Access preflight
 * (spec §3.3) gates the POST behind an OPTIONS request that must carry
 * `Access-Control-Allow-Private-Network: true`.
 */
export function waitForCallback(expectedState: string): Promise<AuthTokens> {
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
      // Chrome's Local-Network-Access preflight (PNA, spec §3.3): the
      // browser page lives on a public origin (the platform) and this
      // callback server is localhost — a private-network target — so
      // Chrome's OPTIONS preflight requires this header before it will
      // let the follow-up POST through.
      res.setHeader('Access-Control-Allow-Private-Network', 'true');

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
                error: 'Invalid token received (expected a "guuey_user_" API key)',
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
