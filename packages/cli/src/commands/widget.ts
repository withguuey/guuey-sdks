/**
 * `guuey widget keys` — the embeddable widget's signing-key ceremony.
 *
 *   guuey widget keys create [appId] --audience <aud>
 *   guuey widget keys rotate [appId] [--new-secret]
 *   guuey widget keys revoke [appId] [--yes]
 *
 * **What this is for.** A customer embedding the guuey widget needs their
 * end-users to be identified. If they already run an OIDC IdP they configure it
 * directly (`guuey apps update --issuer-url … --audience …`) and never come
 * here. If they do not — the common case for a small team — guuey issues the
 * app its own keypair, and their backend mints end-user tokens against it with
 * `@guuey/widget-auth`. This command is that enrolment.
 *
 * **The app secret is shown exactly once.** The platform stores only its
 * sha256, so it cannot be re-read, re-sent or recovered — the same contract as
 * a personal access token. Everything here is ordered around that: the secret
 * is printed before any step that could fail, and a failure after the mint
 * reports the problem BELOW the secret rather than replacing it.
 *
 * **Why `create` also writes `userAuthConfig`.** A key nothing trusts is not
 * an integration; the app also has to be in `byo` mode pointing at the issuer
 * the key belongs to. Doing both in one command is the difference between a
 * builder being done and a builder reading two more pages of docs. But the
 * write is REFUSED when the app already trusts a different issuer, because
 * changing a live `issuerUrl` re-keys every existing end-user (`deriveByoUserId`
 * hashes the string) and orphans their threads, memory and files. A convenience
 * flag must not be able to do that; `guuey apps update` is where that decision
 * gets made deliberately.
 */
import { requireAuth, type AuthTokens } from '../auth';
import { resolveConfig, type ResolvedConfig } from '../config';
import { apiRequest, parseApiError } from '../deploy-shared';
import { parseYesNoAnswer, resolveMcpDeleteConfirmation } from './mcp';
import * as out from '../output';

// ─── Wire shapes (mirror cliApi's `handlers/widget-keys.ts`) ────────────

/** The app's issuer binding as the ceremony found it. */
export interface WidgetCurrentAuth {
  mode: string | null;
  issuerUrl: string | null;
  audience: string | null;
}

export interface WidgetKeyCreated {
  appId: string;
  kid: string;
  issuerUrl: string;
  /** The ONE time this value exists outside the customer's own storage. */
  appSecret: string;
  createdAt: string;
  currentAuth: WidgetCurrentAuth;
}

export interface WidgetKeyRotated {
  appId: string;
  kid: string;
  previousKid: string;
  issuerUrl: string;
  rotatedAt: string;
  /** How long BOTH keys stay published — the safe redeploy window. */
  overlapSeconds: number;
  /** Present only with `--new-secret`. */
  appSecret?: string;
}

export interface WidgetKeyRevoked {
  appId: string;
  revoked: true;
  revokedAt: string;
}

/** The injectable API seam (defaults to the real one; tests pass a fake). */
interface WidgetDeps {
  api?: typeof apiRequest;
  confirm?: (question: string) => Promise<string>;
}

async function call<T>(
  deps: WidgetDeps | undefined,
  auth: { pat: string },
  config: { apiUrl?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const api = deps?.api ?? apiRequest;
  const res = await api(auth.pat, config, method, path, body);
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  return (await res.json()) as T;
}

// ─── The configure decision (pure) ─────────────────────────────────────

export type WidgetConfigureDecision =
  | { action: 'configure'; issuerUrl: string; audience: string }
  | { action: 'skip'; hint: string }
  | { action: 'conflict'; message: string };

/**
 * Should `keys create` write `userAuthConfig` for this app, and if not, what
 * should the operator be told?
 *
 * Pure on purpose: this is the one decision in the ceremony that can destroy
 * data (repointing a live issuer re-keys every end-user), so it is decided from
 * values the server just reported, testable without a network, and never
 * inferred from a second read that could race the first.
 */
export function resolveWidgetConfigure(opts: {
  issuerUrl: string;
  audience: string | undefined;
  currentAuth: WidgetCurrentAuth;
}): WidgetConfigureDecision {
  const manual =
    `guuey apps update <appId> --auth-mode byo --issuer-url ${opts.issuerUrl} ` +
    '--audience <your-audience>';

  if (!opts.audience) {
    return {
      action: 'skip',
      hint:
        'The key is minted but the app does not trust it yet. Finish with:\n' +
        `    ${manual}\n` +
        '  (or re-run keys create with --audience to do it in one step).',
    };
  }

  const stored = opts.currentAuth.issuerUrl;
  if (stored && stored !== opts.issuerUrl) {
    return {
      action: 'conflict',
      message:
        `This app already trusts a different issuer (${stored}), so its ` +
        'issuer binding was left untouched. End-user ids are derived by hashing ' +
        'that exact string, so repointing it would give every existing user of ' +
        'this app a new identity and orphan their threads, memory and files. ' +
        'If that is genuinely what you want, do it deliberately:\n' +
        `    ${manual}`,
    };
  }

  return {
    action: 'configure',
    issuerUrl: opts.issuerUrl,
    audience: opts.audience,
  };
}

// ─── create ────────────────────────────────────────────────────────────

export interface WidgetKeysCreateResult {
  created: WidgetKeyCreated;
  configured: boolean;
  /** Why the app was not configured, when it was not. */
  configureError?: string;
  /** What to run next, when there is something to run. */
  hint?: string;
}

/**
 * Mint, then (optionally) bind — in that order, and never the reverse.
 *
 * Minting first is deliberate. An enrolled key that nothing trusts yet is
 * inert: no token is minted against it, and nothing changes for anyone. A
 * binding written before the key existed would be the opposite — the app would
 * be in `byo` mode pointing at an issuer whose JWKS 404s, so every end-user
 * request would fail until the key landed.
 *
 * A failed configure is returned, not thrown, because the response of the
 * FIRST call contains a secret that can never be retrieved again. Throwing here
 * would be the CLI destroying the one copy of a credential it just created.
 */
export async function widgetKeysCreateCore(
  opts: {
    appId: string;
    audience?: string;
    auth: { pat: string };
    config: { apiUrl?: string };
  },
  deps?: WidgetDeps,
): Promise<WidgetKeysCreateResult> {
  const created = await call<WidgetKeyCreated>(
    deps,
    opts.auth,
    opts.config,
    'POST',
    `/apps/${opts.appId}/widget-keys`,
  );

  const decision = resolveWidgetConfigure({
    issuerUrl: created.issuerUrl,
    audience: opts.audience,
    currentAuth: created.currentAuth,
  });

  if (decision.action === 'skip') {
    return { created, configured: false, hint: decision.hint };
  }
  if (decision.action === 'conflict') {
    return { created, configured: false, configureError: decision.message };
  }

  try {
    await call(deps, opts.auth, opts.config, 'PUT', `/apps/${opts.appId}`, {
      // Both, together: the verify path only runs for a `byo` app, so a binding
      // without the mode is a key nothing will ever check.
      userAuthMode: 'byo',
      userAuthConfig: {
        issuerUrl: decision.issuerUrl,
        audience: decision.audience,
      },
    });
  } catch (err) {
    return {
      created,
      configured: false,
      configureError: err instanceof Error ? err.message : String(err),
      hint:
        'The key was minted; only the app configuration failed. Retry with:\n' +
        `    guuey apps update ${opts.appId} --auth-mode byo ` +
        `--issuer-url ${created.issuerUrl} --audience ${decision.audience}`,
    };
  }

  return { created, configured: true };
}

/** `guuey widget keys create [appId] --audience <aud>` */
export async function widgetKeysCreate(
  appId: string | undefined,
  opts: { audience?: string; json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const auth: AuthTokens = requireAuth();
  const config: ResolvedConfig = resolveConfig();

  const result = await widgetKeysCreateCore({
    appId: resolved,
    audience: opts.audience,
    auth,
    config,
  });

  if (opts.json) {
    // The secret rides the JSON too: a script automating enrolment has the same
    // one-time-only problem a human does, and hiding it would just push people
    // back to copying it off a terminal.
    out.json(result);
    return;
  }

  const { created } = result;
  out.success(`Widget signing key created for ${created.appId}`);
  console.log('');
  console.log(`  Issuer:      ${created.issuerUrl}`);
  console.log(`  Key ID:      ${created.kid}`);
  console.log('');
  console.log('  App secret (shown once — store it now, it cannot be shown again):');
  console.log('');
  console.log(`    ${created.appSecret}`);
  console.log('');

  if (result.configured) {
    console.log('  The app is configured to trust this issuer (userAuthMode: byo).');
  }
  if (result.configureError) {
    out.error(result.configureError);
  }
  if (result.hint) {
    console.log(`  ${result.hint}`);
  }
}

// ─── rotate ────────────────────────────────────────────────────────────

export async function widgetKeysRotateCore(
  opts: {
    appId: string;
    newSecret?: boolean;
    auth: { pat: string };
    config: { apiUrl?: string };
  },
  deps?: WidgetDeps,
): Promise<WidgetKeyRotated> {
  return call<WidgetKeyRotated>(
    deps,
    opts.auth,
    opts.config,
    'POST',
    `/apps/${opts.appId}/widget-keys/rotate`,
    opts.newSecret ? { newSecret: true } : {},
  );
}

/**
 * `guuey widget keys rotate [appId] [--new-secret]`
 *
 * Zero downtime by construction: both public keys stay published for the
 * overlap window, so tokens minted under the old key keep verifying and
 * verifiers holding a cached JWKS keep working. Not destructive, so no
 * confirmation gate — unlike `revoke`.
 *
 * `--new-secret` is the one part that IS disruptive, and only to the customer's
 * own backend: the old secret stops working immediately, so their service
 * cannot mint until it ships the new value. That is why it is opt-in rather
 * than part of "rotate" by default.
 */
export async function widgetKeysRotate(
  appId: string | undefined,
  opts: { newSecret?: boolean; json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const result = await widgetKeysRotateCore({
    appId: resolved,
    newSecret: opts.newSecret === true,
    auth: requireAuth(),
    config: resolveConfig(),
  });

  if (opts.json) {
    out.json(result);
    return;
  }

  out.success(`Rotated the widget signing key for ${result.appId}`);
  console.log('');
  console.log(`  New key ID:  ${result.kid}`);
  console.log(`  Retiring:    ${result.previousKid}`);
  console.log(
    `  Both keys stay published for ${Math.round(result.overlapSeconds / 60)} minutes, ` +
      'so tokens already issued keep working.',
  );
  if (result.appSecret) {
    console.log('');
    console.log('  New app secret (shown once — the previous one stopped working NOW):');
    console.log('');
    console.log(`    ${result.appSecret}`);
    console.log('');
  }
}

// ─── revoke ────────────────────────────────────────────────────────────

export type WidgetKeysRevokeResult =
  | { status: 'refused'; error: string }
  | { status: 'aborted' }
  | { status: 'revoked'; revokedAt: string };

/**
 * Revocation is TERMINAL: `create` is create-only and `rotate` refuses a
 * revoked row, so nothing brings the app's widget identity back. It therefore
 * runs behind the same destructive-op gate as `mcp delete` / `mcp state wipe`
 * — `--yes`, or an interactive confirmation, or an outright refusal when there
 * is no channel to confirm on ({@link resolveMcpDeleteConfirmation}, reused
 * rather than re-derived so all three commands cannot drift apart).
 */
export async function widgetKeysRevokeCore(
  opts: {
    appId: string;
    yes: boolean;
    stdinIsTTY: boolean | undefined;
    stdoutIsTTY: boolean | undefined;
    auth: { pat: string };
    config: { apiUrl?: string };
  },
  deps?: WidgetDeps,
): Promise<WidgetKeysRevokeResult> {
  const confirmation = resolveMcpDeleteConfirmation({
    yes: opts.yes,
    stdinIsTTY: opts.stdinIsTTY,
    stdoutIsTTY: opts.stdoutIsTTY,
  });

  if (confirmation === 'refuse') {
    return {
      status: 'refused',
      error:
        `Refusing to revoke the widget signing key for '${opts.appId}' without ` +
        'confirmation in a non-interactive session. Revocation is permanent — ' +
        'pass --yes to confirm.',
    };
  }

  if (confirmation === 'prompt') {
    const ask = deps?.confirm ?? defaultConfirm;
    const answer = await ask(
      `  Revoke the widget signing key for '${opts.appId}'? This is permanent — ` +
        'every embedded widget for this app stops authenticating end-users, and ' +
        'the key cannot be restored. [y/N] ',
    );
    if (!parseYesNoAnswer(answer)) return { status: 'aborted' };
  }

  const revoked = await call<WidgetKeyRevoked>(
    deps,
    opts.auth,
    opts.config,
    'DELETE',
    `/apps/${opts.appId}/widget-keys`,
  );
  return { status: 'revoked', revokedAt: revoked.revokedAt };
}

/** One-shot readline question — the default `deps.confirm`. */
async function defaultConfirm(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}

/** `guuey widget keys revoke [appId] [--yes]` */
export async function widgetKeysRevoke(
  appId: string | undefined,
  opts: { yes?: boolean; json?: boolean },
): Promise<void> {
  const resolved = appId ?? resolveConfig().appId;
  if (!resolved) {
    out.error('No app ID provided. Pass an app ID or set via: guuey config set app-id <id>');
    process.exit(1);
  }

  const result = await widgetKeysRevokeCore({
    appId: resolved,
    yes: opts.yes === true,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    auth: requireAuth(),
    config: resolveConfig(),
  });

  if (result.status === 'refused') {
    out.error(result.error);
    process.exit(1);
  }
  if (result.status === 'aborted') {
    console.log('Cancelled.');
    return;
  }

  if (opts.json) {
    out.json({ appId: resolved, revoked: true, revokedAt: result.revokedAt });
    return;
  }
  out.success(`Revoked the widget signing key for ${resolved}`);
  console.log('  The app no longer publishes a JWKS and cannot mint end-user tokens.');
}
