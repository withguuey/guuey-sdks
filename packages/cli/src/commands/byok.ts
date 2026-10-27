/**
 * `guuey byok` — bring-your-own-key (BYOK) provider keys, on an app or on a
 * workspace (guuey#2412):
 *
 *   set    --provider <id> [--app-id <id> | --workspace <id|slug>]   key on stdin
 *   status [--app-id <id> | --workspace <id|slug>] [--json]          (`list` is an alias)
 *   remove --provider <id> [--app-id <id> | --workspace <id|slug>]
 *
 * With neither target flag, the bound project's app is used (`env`'s rule).
 * The two are mutually exclusive.
 *
 * **The key comes from stdin, never argv** (`../secret-input.ts`): a key
 * flag in any spelling, or a positional argument, is refused before any
 * request, because the command line lands in shell history.
 *
 * **Provider ids are the stored ids.** `set` takes only `@guuey/config`'s
 * `BYOK_PROVIDER_IDS`; `remove` takes any id and lets the server decide, so
 * a stored row for a provider no runtime reads (an old `bedrock`) can be
 * removed.
 *
 * **Server faces.** A `404 NOT_FOUND` on these paths is the
 * unknown-route fall-through: a server older than the routes. A
 * `404 PROVIDER_KEYS_NOT_FOUND` is every refusal of the target (no such app
 * or workspace, not yours, below the floor). They are told apart by code
 * alone, with no second probe request. Any other failure, a scope-gate 403
 * included, prints the server's own message through `out.apiErrorMessage`.
 *
 * Every call names its route as a literal (`'PUT', `/apps/${…}/keys/providers/${…}``),
 * one per target kind, so `scripts/oss-cli-routes.mjs` reads each route this
 * command calls and the release gate can check prod serves it.
 */

import { BYOK_PROVIDER_IDS, type ByokProviderId, isByokProviderId } from '@guuey/config';
import { requireAuth } from '../auth';
import { type ResolvedConfig, resolveConfig } from '../config';
import { resolveTargetAppId } from '../app-id';
import * as out from '../output';
import { apiRequest } from '../deploy-shared';
import { readSecretFromStdin, type SecretInputStream } from '../secret-input';

// ─── Wire mirrors ────────────────────────────────────────────────────
//
// Hand mirrors of `@guuey-private/cli-wire` `provider-keys.ts` (this package
// is published and cannot depend on it); `wire-sync.test.ts` pins every
// interface below to its twin by field name and optionality.

/** Where a provider's key comes from. */
export type KeySource = 'app' | 'workspace' | 'managed';

/** The tier a stored provider-key row lives on. */
export type KeyTier = 'app' | 'workspace';

/** The status a stored row shows: its own status column. A row no runtime reads is listed apart, under `unsupported`. */
export type StoredKeyStatus = 'active' | 'revoked';

/** One stored provider-key row, as display columns only. */
export interface StoredKeyFace {
  /** `null` = set before last-4 tracking. */
  keyLast4: string | null;
  status: StoredKeyStatus;
  /** When the key was written (ISO); `null` for a row that recorded no write time. */
  setAt: string | null;
}

/** What the next deploy uses for one provider. */
export interface ConfiguredProviderKey {
  source: KeySource;
  keyLast4: string | null;
}

/** What the running build uses (the deployment's own stamp). Absent until the server records it. */
export interface ProviderKeyInUse {
  source: KeySource | 'unknown';
  keyLast4: string | null;
  build: number;
  fallbackReason?: string;
}

/** One provider on an app. */
export interface AppProviderKeyEntry {
  provider: ByokProviderId;
  configured: ConfiguredProviderKey;
  app: StoredKeyFace | null;
  /** Always `null` for a personal app. */
  workspace: StoredKeyFace | null;
  inUse?: ProviderKeyInUse;
}

/** A personal app. */
export interface PersonalAppOwner {
  kind: 'personal';
}

/** A workspace app, and the workspace whose keys it inherits. */
export interface WorkspaceAppOwner {
  kind: 'workspace';
  workspaceId: string;
  slug: string;
}

/** A stored row for a provider no runtime slot reads. */
export interface UnsupportedAppProviderKey {
  provider: string;
  tier: KeyTier;
}

/** `GET /v1/apps/:id/keys/providers`. */
export interface AppProviderKeysWire {
  appId: string;
  owner: PersonalAppOwner | WorkspaceAppOwner;
  providers: AppProviderKeyEntry[];
  unsupported: UnsupportedAppProviderKey[];
  /** Names only, never values. Absent on an older server, and absent is never "none stored". */
  plainSlotEnvNames?: string[];
  appliesOn: 'next-deploy';
}

/** One provider on a workspace. */
export interface WorkspaceProviderKeyEntry {
  provider: ByokProviderId;
  key: StoredKeyFace | null;
}

/** A stored workspace row for a provider no runtime slot reads. */
export interface UnsupportedWorkspaceProviderKey {
  provider: string;
}

/** `GET /v1/workspaces/:ref/keys/providers`. */
export interface WorkspaceProviderKeysWire {
  workspaceId: string;
  slug: string;
  providers: WorkspaceProviderKeyEntry[];
  unsupported: UnsupportedWorkspaceProviderKey[];
  appliesOn: 'next-deploy';
}

/** The body of both PUTs. */
export interface SetProviderKeyBody {
  apiKey: string;
}

/** `PUT …/keys/providers/:provider` → 200. */
export interface SetProviderKeyResult {
  provider: ByokProviderId;
  tier: KeyTier;
  /** `null` for a key under 16 characters (the server records no last 4 for it). */
  keyLast4: string | null;
  rotated: boolean;
  message: string;
}

/** What an app's next deploy falls to after a removal. */
export interface ProviderKeyFallback {
  source: KeySource;
  keyLast4: string | null;
}

/** `DELETE …/keys/providers/:provider` → 200 (idempotent). */
export interface RemoveProviderKeyResult {
  /** Any stored id, not only a BYOK provider id. */
  provider: string;
  tier: KeyTier;
  removed: boolean;
  /** App tier and a supported provider only. */
  next?: ProviderKeyFallback;
  message: string;
}

/** The 404 code every refusal of the target answers on these routes. */
export const PROVIDER_KEYS_NOT_FOUND = 'PROVIDER_KEYS_NOT_FOUND';

/** The 400 code a workspace PUT on the caller's own personal workspace answers. */
export const PERSONAL_WORKSPACE_PROVIDER_KEY = 'PERSONAL_WORKSPACE_PROVIDER_KEY';

// ─── Target + request ────────────────────────────────────────────────

/** What a `byok` command acts on. */
type Target = { kind: 'app'; appId: string } | { kind: 'workspace'; ref: string };

/** How a refusal of the target reads: writes need an admin, `status` a member. */
type Standing = 'admin' | 'member';

const PIPE_HINT = 'Pipe it: guuey byok set --provider anthropic --app-id <id> < key.txt';

/**
 * The target from `--app-id` / `--workspace` (mutually exclusive), else the
 * bound app. Exits 1 on a conflict or when there is no target at all.
 */
function resolveTarget(flags: Record<string, string | true>, config: ResolvedConfig): Target {
  const workspace = flags.workspace;
  if (workspace !== undefined && flags['app-id'] !== undefined) {
    out.error('Pass --app-id or --workspace, not both.');
    process.exit(1);
  }
  if (workspace === true) {
    out.error('--workspace needs a workspace id or slug.');
    process.exit(1);
  }
  if (typeof workspace === 'string') return { kind: 'workspace', ref: workspace };
  const appId = resolveTargetAppId(flags, config);
  if (!appId) {
    out.error(
      'No app ID found. Pass --app-id <id> or --workspace <id|slug>, or run "guuey pull --app-id <id>" to bind an app.',
    );
    process.exit(1);
  }
  return { kind: 'app', appId };
}

/** `target` as a success line names it. */
function targetLabel(target: Target): string {
  return target.kind === 'app' ? `app ${target.appId}` : `workspace ${target.ref}`;
}

/** The console page that manages `target`'s provider keys. */
function consoleUrl(config: ResolvedConfig, target: Target): string {
  const base = (config.platformUrl ?? config.host).replace(/\/+$/, '');
  return target.kind === 'app'
    ? `${base}/apps/${encodeURIComponent(target.appId)}/behavior`
    : `${base}/settings/workspaces`;
}

/**
 * Print a failed answer and exit 1. `pointer` adds a command line for a code
 * this door knows how to answer (a personal-workspace set, a pending
 * deletion); every other failure prints the server's message alone.
 */
async function fail(
  res: Response,
  config: ResolvedConfig,
  target: Target,
  standing: Standing,
  pointer?: (status: number, code: string | undefined) => string | undefined,
): Promise<never> {
  // A body that is not JSON (a gateway page) leaves only the status to print.
  const body: unknown = await res.json().catch(() => null);
  const code = out.apiErrorCode(body);
  if (res.status === 404 && code === 'NOT_FOUND') {
    out.error(
      `This Guuey server doesn't support provider keys from the CLI yet. Use the console: ${consoleUrl(config, target)}`,
    );
  } else if (res.status === 404 && code === PROVIDER_KEYS_NOT_FOUND) {
    out.error(`No such app or workspace, or you aren't ${standing === 'admin' ? 'an admin' : 'a member'} of it.`);
  } else {
    out.error(out.apiErrorMessage(body, `HTTP ${res.status}`));
    const line = pointer?.(res.status, code);
    if (line !== undefined) console.error(line);
  }
  process.exit(1);
}

/** The flag names that would carry a key on the command line: `--key`, `--api-key`, `--apiKey`, `--key=…`, … */
function isKeyFlag(name: string): boolean {
  const bare = (name.split('=')[0] ?? '').toLowerCase().replace(/[-_]/g, '');
  return bare.endsWith('key');
}

// ─── set ─────────────────────────────────────────────────────────────

/**
 * `guuey byok set --provider <id> [--app-id <id> | --workspace <id|slug>]`,
 * the key on stdin. `positional` is the command's leftover arguments, all
 * refused: a key there would be on the command line too.
 */
export async function byokSet(
  flags: Record<string, string | true>,
  positional: readonly string[] = [],
  input: SecretInputStream = process.stdin,
): Promise<void> {
  if (positional.length > 0 || Object.keys(flags).some(isKeyFlag)) {
    out.error(`Keys are never read from the command line (shell history). ${PIPE_HINT}`);
    process.exit(1);
  }
  const provider = flags.provider;
  if (typeof provider !== 'string') {
    out.error(`Missing --provider. One of: ${BYOK_PROVIDER_IDS.join(', ')}. Use: guuey byok set --provider anthropic --app-id <id> < key.txt`);
    process.exit(1);
  }
  if (!isByokProviderId(provider)) {
    out.error(`Invalid provider "${provider}". Must be one of: ${BYOK_PROVIDER_IDS.join(', ')}`);
    process.exit(1);
  }
  const config = resolveConfig();
  const target = resolveTarget(flags, config);
  // Signed in before the prompt, so a TTY user never pastes a key only to be told to log in.
  const { pat } = requireAuth();

  const read = await readSecretFromStdin(input, `Paste the ${provider} key (input hidden): `);
  if (!read.ok) {
    out.error(
      read.reason === 'empty'
        ? `No key on stdin. ${PIPE_HINT}`
        : 'The key on stdin spans more than one line. Pipe exactly one key.',
    );
    process.exit(1);
  }

  const body: SetProviderKeyBody = { apiKey: read.secret };
  const res =
    target.kind === 'app'
      ? await apiRequest(pat, config, 'PUT', `/apps/${encodeURIComponent(target.appId)}/keys/providers/${provider}`, body)
      : await apiRequest(pat, config, 'PUT', `/workspaces/${encodeURIComponent(target.ref)}/keys/providers/${provider}`, body);
  if (!res.ok) {
    return fail(res, config, target, 'admin', (status, code) => {
      if (code === PERSONAL_WORKSPACE_PROVIDER_KEY) return `Use: guuey byok set --provider ${provider} --app-id <id>`;
      // A pending deletion is the only conflict the app PUT answers.
      if (status === 409 && target.kind === 'app') return `Use: guuey apps recover ${target.appId}`;
      return undefined;
    });
  }

  const result = (await res.json()) as SetProviderKeyResult;
  const replaced = result.rotated ? ', replacing the previous one' : '';
  const applies = target.kind === 'app' ? 'the next deploy' : "each app's next deploy";
  out.success(
    `Saved ${provider} key${result.keyLast4 === null ? '' : ` ••••${result.keyLast4}`} on ${targetLabel(target)}${replaced}. Takes effect on ${applies}.`,
  );
}

// ─── status ──────────────────────────────────────────────────────────

const NO_LAST4 = 'set before last-4 tracking. Replace to record it.';
const MANAGED = "managed (the platform's key)";

/** A stored row as one status cell. */
function storedCell(face: StoredKeyFace | null): string {
  if (face === null) return 'none';
  const key = face.keyLast4 === null ? NO_LAST4 : `••••${face.keyLast4}`;
  return `${key} · ${face.status} · set ${face.setAt ?? 'unknown'}`;
}

/** A source and its last 4, as the Configured / In use cells say it. */
function sourceCell(source: KeySource, keyLast4: string | null): string {
  if (source === 'managed') return MANAGED;
  const label = source === 'app' ? 'app key' : 'workspace key';
  return keyLast4 === null ? `${label} (${NO_LAST4})` : `${label} ••••${keyLast4}`;
}

function inUseCell(inUse: ProviderKeyInUse | undefined): string {
  if (inUse === undefined) return 'unknown until the next deploy records it';
  const head = inUse.source === 'unknown' ? 'unknown' : sourceCell(inUse.source, inUse.keyLast4);
  const reason = inUse.fallbackReason === undefined ? '' : ` (${inUse.fallbackReason})`;
  return `${head}, build ${inUse.build}${reason}`;
}

/** The exact command that removes an unsupported row. */
function unsupportedLine(provider: string, tier: KeyTier, removeTarget: string): string {
  return `${provider} (${tier}): no runtime reads this key. Remove it: guuey byok remove --provider ${provider} ${removeTarget}`;
}

function printAppStatus(wire: AppProviderKeysWire): void {
  const owner = wire.owner.kind === 'workspace' ? `workspace ${wire.owner.slug}` : 'personal';
  console.log(`Provider keys for app ${wire.appId} (${owner})`);
  console.log('');
  for (const entry of wire.providers) {
    console.log(`  ${entry.provider}`);
    console.log(`    Configured:    ${sourceCell(entry.configured.source, entry.configured.keyLast4)}`);
    console.log(`    App key:       ${storedCell(entry.app)}`);
    if (wire.owner.kind === 'workspace') console.log(`    Workspace key: ${storedCell(entry.workspace)}`);
    console.log(`    In use:        ${inUseCell(entry.inUse)}`);
  }
  if (wire.unsupported.length > 0) {
    console.log('');
    for (const row of wire.unsupported) {
      const removeTarget =
        row.tier === 'app'
          ? `--app-id ${wire.appId}`
          : `--workspace ${wire.owner.kind === 'workspace' ? wire.owner.slug : '<workspace>'}`;
      console.log(unsupportedLine(row.provider, row.tier, removeTarget));
    }
  }
  // Absent (an older server) and empty both print nothing: absent is never read as "none stored".
  const plain = wire.plainSlotEnvNames ?? [];
  if (plain.length > 0) {
    console.log('');
    console.log("Plain variables named like a provider key (they don't switch the app to your key):");
    for (const name of plain) {
      console.log(`  ${name}. Remove it: guuey env unset ${name} --app-id ${wire.appId}`);
    }
  }
  console.log('');
  console.log('Keys apply on the next deploy.');
}

function printWorkspaceStatus(wire: WorkspaceProviderKeysWire): void {
  console.log(`Provider keys for workspace ${wire.slug} (${wire.workspaceId})`);
  console.log('');
  const width = Math.max(...wire.providers.map((entry) => entry.provider.length));
  for (const entry of wire.providers) {
    console.log(`  ${entry.provider.padEnd(width)}  ${storedCell(entry.key)}`);
  }
  if (wire.unsupported.length > 0) {
    console.log('');
    for (const row of wire.unsupported) {
      console.log(unsupportedLine(row.provider, 'workspace', `--workspace ${wire.slug}`));
    }
  }
  console.log('');
  console.log("Apps in this workspace use these keys unless they set their own. Keys apply on each app's next deploy.");
}

/** `guuey byok status [--app-id <id> | --workspace <id|slug>] [--json]` (and its alias `list`). */
export async function byokStatus(flags: Record<string, string | true>): Promise<void> {
  const config = resolveConfig();
  const target = resolveTarget(flags, config);
  const { pat } = requireAuth();
  const res =
    target.kind === 'app'
      ? await apiRequest(pat, config, 'GET', `/apps/${encodeURIComponent(target.appId)}/keys/providers`)
      : await apiRequest(pat, config, 'GET', `/workspaces/${encodeURIComponent(target.ref)}/keys/providers`);
  if (!res.ok) return fail(res, config, target, 'member');

  if (target.kind === 'app') {
    const wire = (await res.json()) as AppProviderKeysWire;
    if (flags.json === true) out.json(wire);
    else printAppStatus(wire);
    return;
  }
  const wire = (await res.json()) as WorkspaceProviderKeysWire;
  if (flags.json === true) out.json(wire);
  else printWorkspaceStatus(wire);
}

// ─── remove ──────────────────────────────────────────────────────────

/** What an app's next deploy falls to, in the server's own words for it. */
function fallbackSentence(next: ProviderKeyFallback): string {
  switch (next.source) {
    case 'managed':
      return "The next deploy uses the platform's managed key.";
    case 'workspace':
      return next.keyLast4 === null
        ? 'The next deploy uses the workspace key.'
        : `The next deploy uses the workspace key ••••${next.keyLast4}.`;
    case 'app':
      return next.keyLast4 === null
        ? "The next deploy uses the app's key."
        : `The next deploy uses the app's key ••••${next.keyLast4}.`;
  }
}

/**
 * `guuey byok remove --provider <id> [--app-id <id> | --workspace <id|slug>]`.
 * Any provider id is sent: the server's legacy validator decides, so a stored
 * row for a provider no runtime reads stays removable.
 */
export async function byokRemove(flags: Record<string, string | true>): Promise<void> {
  const provider = flags.provider;
  if (typeof provider !== 'string') {
    out.error('Missing --provider. Use: guuey byok remove --provider <id> --app-id <id>');
    process.exit(1);
  }
  const config = resolveConfig();
  const target = resolveTarget(flags, config);
  const { pat } = requireAuth();
  const segment = encodeURIComponent(provider);
  const res =
    target.kind === 'app'
      ? await apiRequest(pat, config, 'DELETE', `/apps/${encodeURIComponent(target.appId)}/keys/providers/${segment}`)
      : await apiRequest(pat, config, 'DELETE', `/workspaces/${encodeURIComponent(target.ref)}/keys/providers/${segment}`);
  if (!res.ok) return fail(res, config, target, 'admin');

  const result = (await res.json()) as RemoveProviderKeyResult;
  if (!result.removed) {
    out.success(`No ${provider} key was stored on ${targetLabel(target)}. Nothing to remove.`);
    return;
  }
  const after =
    target.kind === 'workspace'
      ? ' Its apps fall back on their next deploy.'
      : result.next === undefined
        ? ''
        : ` ${fallbackSentence(result.next)}`;
  out.success(`Removed ${provider} key from ${targetLabel(target)}.${after}`);
}
