/**
 * guuey login — Browser-based authentication.
 *
 * Opens the platform's CLI auth page in the browser. The platform
 * authenticates the user, generates a PAT, and sends it to a
 * localhost callback.
 */

import * as http from 'node:http';
import * as readline from 'node:readline';
import { Writable } from 'node:stream';
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
 * Three modes:
 * 1. **Browser auth** (default): Opens browser, mints a `guuey_user_*` API key
 *    server-side, delivers it to the CLI via localhost callback. While the
 *    callback listener waits, a token pasted on stdin is accepted too — the
 *    first channel to produce a valid key wins (the authorize page shows the
 *    key for copy-paste, so a browser on another machine still works).
 * 2. **Paste-only** (`--no-browser`): For known-headless sessions (SSH,
 *    devcontainer, CI box). Prints the authorize URL with no callback param;
 *    the page always shows the minted key, the CLI just waits for the paste.
 * 3. **Token auth** (`--token`): Accepts a pre-minted `guuey_user_*` API key
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
      expiresAt: new Date(Date.now() + NOMINAL_TTL_MS).toISOString(),
    });
    out.success('Logged in with API key (server-side expiry applies)');
    return;
  }

  const config = resolveConfig();
  const endpoint = config.host!;

  // Print the resolved host BEFORE anything opens — a prod-minted key against
  // a dev API reads as broken auth (the 2026-08-08 / 2026-08-14 mismatch
  // class); this line makes the mismatch visible while it is still cheap.
  console.log(`Authenticating against ${endpoint}`);

  if (flags['no-browser'] === true) {
    // Known-headless: no listener, no callback param — the authorize page
    // sees mode=paste and always displays the minted key for copy-paste.
    const authUrl = pasteAuthorizeUrl(endpoint);
    console.log('Open this URL in a browser to authenticate:\n');
    console.log(`  ${authUrl}\n`);
    // Claim "hidden" only when it is true: echo-muting is TTY-gated below,
    // and interactive-but-non-TTY stdin (git-bash/mintty ptys present as
    // pipes) still echoes at the pty layer — a hiddenness claim there would
    // be false security.
    console.log(
      process.stdin.isTTY === true
        ? 'Then paste the token shown in the browser here (input is hidden):'
        : 'Then paste the token shown in the browser here:',
    );
    let tokens: AuthTokens;
    try {
      // Paste is the ONLY channel here — an input that ends without a valid
      // token must fail loudly (exit 1), not drain the event loop into a
      // false-success exit 0 (guuey#255, the scripts-piping-stdin case).
      tokens = await waitForPastedToken(undefined, process.stdin, { rejectOnEnd: true });
    } catch (err) {
      out.error((err as Error).message);
      process.exit(1);
    }
    saveAuth(tokens);
    out.success('Logged in with API key (server-side expiry applies)');
    return;
  }

  const state = randomBytes(16).toString('hex');
  const callbackUrl = `http://localhost:${CLI_CALLBACK_PORT}/callback`;

  const authUrl = `${endpoint}/cli/authorize?state=${state}&callback=${encodeURIComponent(callbackUrl)}`;

  // Start the callback server, then try to open browser. When stdin is a
  // TTY, ALSO accept a pasted token — on a remote session the browser's
  // localhost redirect lands on the wrong machine, and the paste is the
  // only channel that can ever complete. First valid token wins; the
  // AbortController tears down the losing channel.
  const abort = new AbortController();
  const channels = [waitForCallback(state, abort.signal)];
  const canPaste = process.stdin.isTTY === true;
  if (canPaste) channels.push(waitForPastedToken(abort.signal));

  setTimeout(() => {
    const opened = openBrowser(authUrl);
    if (opened) {
      console.log('Opening browser for authentication...');
      console.log('If the browser doesn\'t open, copy this URL:\n');
    } else {
      console.log('Open this URL in your browser to authenticate:\n');
    }
    console.log(`  ${authUrl}\n`);
    console.log(
      canPaste
        ? 'Waiting for authentication... (or paste the token from the browser here — input is hidden)'
        : 'Waiting for authentication...',
    );
  }, 300);

  try {
    const tokens = await Promise.race(channels);
    saveAuth(tokens);

    // guuey_user_ keys are opaque — there is no email/sub to print.
    out.success('Logged in with API key (server-side expiry applies)');
  } catch (err) {
    out.error((err as Error).message);
    process.exit(1);
  } finally {
    // Tear down the losing channel (close the HTTP listener / release
    // stdin) so the process can exit.
    abort.abort();
  }
}

/**
 * The `--no-browser` authorize URL: no state (there is no listener to bind
 * to — possession of the pasted key is the proof) and no callback; the
 * `mode=paste` marker tells the authorize page to always display the
 * minted key for copy-paste.
 */
export function pasteAuthorizeUrl(endpoint: string): string {
  return `${endpoint}/cli/authorize?mode=paste`;
}

/**
 * Mask an API key for display: public prefix + last 4 characters only
 * (`guuey_user_…abc4`). Everything a paste flow prints about the token
 * goes through this — the cleartext key must never reach the terminal
 * (guuey#255; the terminal echo itself is muted separately below).
 */
export function maskToken(pat: string): string {
  return `${pat.slice(0, 11)}…${pat.slice(-4)}`;
}

/** Options for {@link waitForPastedToken}. */
export interface PasteWaitOptions {
  /**
   * When true, an input that ends (EOF / closed pipe) before a valid token
   * REJECTS with a clear error. Set by the paste-only `--no-browser` path,
   * where the paste is the sole channel — a script piping empty stdin must
   * exit non-zero, not fall off the event loop as a false-success exit 0
   * (guuey#255).
   *
   * Default (false): end-of-input releases the stream and leaves the
   * promise pending — race-loser semantics for the browser+paste race,
   * where a stray Ctrl-D must not kill a still-pending browser callback.
   */
  rejectOnEnd?: boolean;
}

/**
 * Wait for a `guuey_user_*` key pasted on stdin (one per line).
 *
 * **The paste is never echoed** (guuey#255): on a TTY, readline runs in
 * terminal mode — which puts the stream in raw mode, disabling the TTY
 * driver's own echo — with a discarding output stream, so neither the
 * driver nor readline writes the key back to the terminal. On success a
 * masked confirmation (`guuey_user_…abc4`) is printed instead. Non-TTY
 * input (pipes, tests) is read as plain lines — nothing echoes there.
 *
 * Invalid pastes re-prompt (never reject), so the promise is safe on the
 * losing side of a `Promise.race`. An aborted signal releases stdin and
 * leaves the promise forever pending (post-race that is unobservable and
 * un-leaked; a rejection here would surface as an unhandled rejection).
 * End-of-input behavior is governed by `opts.rejectOnEnd` (see
 * {@link PasteWaitOptions}).
 *
 * `input` is injectable for tests only; production callers use stdin.
 */
export function waitForPastedToken(
  signal?: AbortSignal,
  input: NodeJS.ReadableStream = process.stdin,
  opts: PasteWaitOptions = {},
): Promise<AuthTokens> {
  return new Promise((resolve, reject) => {
    const isTTY = (input as NodeJS.ReadStream).isTTY === true;
    // Terminal-mode echo target that discards everything — the mute half
    // of the #255 fix. Only constructed for TTYs; plain streams read in
    // non-terminal mode where readline never echoes anyway.
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = isTTY
      ? readline.createInterface({ input, output: muted, terminal: true })
      : readline.createInterface({ input, terminal: false });
    // Set before any deliberate teardown (resolve / reject / abort) so the
    // trailing 'close' event can tell deliberate teardown from EOF.
    let done = false;
    const release = () => {
      rl.close();
      // readline leaves a resumed stream flowing, which keeps the event
      // loop alive after login returns — release it explicitly.
      input.pause();
    };
    const onAbort = () => {
      done = true;
      release();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.on('line', (line) => {
      const pasted = line.trim();
      // In terminal mode the muted output swallows the Enter keypress too —
      // emit the line break ourselves so the prompt line ends visibly.
      if (isTTY) process.stdout.write('\n');
      if (!pasted) return;
      // Same validation + storage shape as the callback / --token paths:
      // possession of the opaque key IS the proof (no `state` needed).
      const tokens = tokensFromCallback(pasted);
      if (!tokens) {
        out.error(
          'That does not look like a Guuey API key (expected a "guuey_user_" token). Paste the token shown in the browser.',
        );
        return;
      }
      done = true;
      signal?.removeEventListener('abort', onAbort);
      release();
      console.log(`Token received: ${maskToken(pasted)}`);
      resolve(tokens);
    });
    rl.on('close', () => {
      if (done) return;
      done = true;
      input.pause();
      if (opts.rejectOnEnd) {
        reject(
          new Error(
            'Input ended before a token was pasted — nothing was stored. ' +
              'Run `guuey login --no-browser` in an interactive terminal, or use `guuey login --token <guuey_user_...>`.',
          ),
        );
      }
      // Default: stay pending — race-loser semantics (the browser-callback
      // channel owns the outcome).
    });
    // Terminal mode (raw): Ctrl-C no longer delivers SIGINT to the process —
    // readline surfaces it as an event. Mark done FIRST (rl.close() emits
    // 'close' synchronously; without the flag the EOF branch would schedule
    // a spurious rejection), restore the terminal, then RE-RAISE the signal
    // so the process dies BY SIGINT (WIFSIGNALED) — a plain exit(130) would
    // hide the interrupt from wrapping shells' abort-on-child-SIGINT
    // convention (e.g. a `for` loop would keep iterating past Ctrl-C). No
    // process-level SIGINT listener is installed, so the default
    // disposition terminates.
    rl.on('SIGINT', () => {
      done = true;
      release();
      process.stdout.write('\n');
      process.kill(process.pid, 'SIGINT');
    });
  });
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
 *
 * An aborted `signal` (the stdin paste won the race) closes the listener
 * and leaves the promise forever pending — post-race that is unobservable;
 * rejecting would surface as an unhandled rejection.
 */
export function waitForCallback(expectedState: string, signal?: AbortSignal): Promise<AuthTokens> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes. Try again.'));
    }, 5 * 60 * 1000);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        server.close();
      },
      { once: true },
    );

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
