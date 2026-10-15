/**
 * `app.access` in guuey.json reaches the app on `guuey deploy` (code and
 * declarative), the same policy `guuey agent apply` converges.
 *
 * Before this, `deploy` read `app.theme` but never `app.access`: a BYO app
 * whose guuey.json named its own issuer went live still verifying end-user
 * tokens against whatever the app record held, and nothing said so.
 *
 * THE DOOR: `PUT /apps/:id` with the four access fields — the handler the
 * reconcile route composes for the same converge, so every server-side rule
 * (issuer trust, the re-key guard, the domain normalization, the member gate)
 * is the one `agent apply` and `guuey apps update` already meet. Field names
 * ARE the API's (`app.access` is declared in that vocabulary), so nothing is
 * translated here.
 *
 * THE ORDER: before the deploy is triggered. A refused write STOPS the deploy
 * before anything goes live — the alternative is the exact failure this
 * closes, an app serving under an access policy its guuey.json does not
 * declare. Like reconcile, only the fields that do not already hold are sent:
 * the app is read first, so a deploy whose access is already in place writes
 * nothing (and a credential that may deploy but not edit the app record — a
 * workspace API key — still deploys when the stored access matches).
 *
 * THE OUTPUT: one `Access:` line naming the mode, the issuer host and guest
 * access — applied or already in place. No `app.access` → nothing read,
 * nothing sent, nothing said; the app's access stays as it is.
 */
import type { GuueyAppAccess, GuueyJsonV1 } from '@guuey/config';
import { apiRequest, parseApiError } from '../deploy-shared';
import type { AppDetail, UpdateAppRequest } from './apps';

/** The access members of the app projection `GET /apps/:id` answers. */
type StoredAccess = Pick<AppDetail, 'userAuthMode' | 'userAuthConfig' | 'allowedDomains' | 'guestAccess'>;

/** The access members `PUT /apps/:id` takes — `app.access`'s own vocabulary. */
export type AccessUpdate = Pick<UpdateAppRequest, 'userAuthMode' | 'userAuthConfig' | 'allowedDomains' | 'guestAccess'>;

export type ConvergeAccessOutcome =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'applied'; fields: (typeof ACCESS_FIELDS)[number][] }
  | { kind: 'refused'; message: string };

export const ACCESS_DOOR_LINE =
  '          The same policy can be set with `guuey apps update <app>` (--auth-mode, --issuer-url/--audience, --domains), `guuey apps access <app> --guests on|off`, or in the console.';

/** The members of `app.access`, in the order the summary and the receipt name them. */
const ACCESS_FIELDS = ['userAuthMode', 'userAuthConfig', 'allowedDomains', 'guestAccess'] as const;

/** `app.access` as guuey.json declares it, else undefined. */
export function accessFromConfig(doc: Pick<GuueyJsonV1, 'app'>): GuueyAppAccess | undefined {
  return doc.app?.access;
}

/** The server's allowedDomains normalization, as far as an equality read needs it (trim, lowercase, de-duplicate). */
function normalizedDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()))];
}

/**
 * The declared fields that do NOT already hold on the stored app — the set a
 * converge must send. `stored` undefined (the read failed) ⇒ every declared
 * field: unknown is never "holds".
 */
export function accessFieldsToSend(access: GuueyAppAccess, stored: StoredAccess | undefined): AccessUpdate {
  const update: AccessUpdate = {};
  if (access.userAuthMode !== undefined && (stored === undefined || (stored.userAuthMode ?? null) !== access.userAuthMode)) {
    update.userAuthMode = access.userAuthMode;
  }
  if (access.userAuthConfig !== undefined) {
    const current = stored?.userAuthConfig;
    const currentBound = current !== undefined && current !== null && typeof current.issuerUrl === 'string' && current.issuerUrl.length > 0;
    const holds =
      stored !== undefined &&
      (access.userAuthConfig === null
        ? !currentBound
        : currentBound && current.issuerUrl === access.userAuthConfig.issuerUrl && current.audience === access.userAuthConfig.audience);
    if (!holds) update.userAuthConfig = access.userAuthConfig;
  }
  if (access.allowedDomains !== undefined) {
    const wanted = normalizedDomains(access.allowedDomains);
    const current = stored === undefined ? undefined : (stored.allowedDomains ?? []);
    const holds = current !== undefined && current.length === wanted.length && current.every((d, i) => d === wanted[i]);
    if (!holds) update.allowedDomains = access.allowedDomains;
  }
  if (access.guestAccess !== undefined && (stored === undefined || (stored.guestAccess ?? null) !== access.guestAccess)) {
    update.guestAccess = access.guestAccess;
  }
  return update;
}

function issuerHost(issuerUrl: string): string {
  try {
    return new URL(issuerUrl).host;
  } catch {
    return issuerUrl;
  }
}

/**
 * The summary the `Access:` line prints — mode, issuer host, guest access —
 * read off the declaration, falling back to the stored value for a member the
 * file does not declare. A member neither side knows is left out.
 */
export function accessSummary(access: GuueyAppAccess, stored: StoredAccess | undefined): string {
  const parts: string[] = [];
  const mode = access.userAuthMode ?? stored?.userAuthMode ?? undefined;
  if (mode !== undefined && mode !== null) parts.push(`mode ${mode}`);
  const config = access.userAuthConfig !== undefined ? access.userAuthConfig : stored?.userAuthConfig;
  if (config === null) parts.push('issuer none');
  else if (config !== undefined && typeof config.issuerUrl === 'string' && config.issuerUrl.length > 0) {
    parts.push(`issuer ${issuerHost(config.issuerUrl)}`);
  }
  const guest = access.guestAccess !== undefined ? access.guestAccess : stored?.guestAccess;
  if (guest === true) parts.push('guest access on');
  else if (guest === false) parts.push('guest access off');
  else if (guest === null) parts.push('guest access default');
  return parts.join(' · ');
}

/**
 * Converge guuey.json's `app.access` onto the app — call BEFORE the deploy
 * trigger; a `refused` outcome means the caller must stop the deploy (the
 * lines naming why are already printed).
 */
export async function convergeAccessFromConfig(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  doc: Pick<GuueyJsonV1, 'app'>,
  deps?: { api?: typeof apiRequest; log?: (line: string) => void; warn?: (line: string) => void },
): Promise<ConvergeAccessOutcome> {
  const access = accessFromConfig(doc);
  if (access === undefined) return { kind: 'none' };
  const api = deps?.api ?? apiRequest;
  const log = deps?.log ?? ((line: string) => console.log(line));
  const warn = deps?.warn ?? ((line: string) => console.error(line));

  // Read the stored access first so only what differs is sent (reconcile's
  // own rule). A failed read is not fatal: every declared field is sent and
  // the server decides.
  let stored: StoredAccess | undefined;
  try {
    const read = await api(pat, config, 'GET', `/apps/${appId}`);
    if (read.ok) {
      const body = (await read.json()) as { app?: StoredAccess };
      stored = body.app;
    }
  } catch (err) {
    if (process.env.GGUI_DEBUG) console.error(`  [access] read failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const update = accessFieldsToSend(access, stored);
  const fields = ACCESS_FIELDS.filter((field) => update[field] !== undefined);
  const summary = accessSummary(access, stored);
  if (fields.length === 0) {
    log(`  Access: app.access already in place — ${summary}.`);
    return { kind: 'held' };
  }

  let res: Response;
  try {
    res = await api(pat, config, 'PUT', `/apps/${appId}`, update);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`  Access: app.access was NOT applied — ${message}. The deploy stopped before going live.`);
    warn(ACCESS_DOOR_LINE);
    return { kind: 'refused', message };
  }
  if (res.ok) {
    log(`  Access: app.access applied (${fields.join(', ')}) — ${summary}.`);
    return { kind: 'applied', fields };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const message = parseApiError(body, `HTTP ${res.status}`);
  warn(`  Access: app.access was NOT applied — ${message}. The deploy stopped before going live, so the app does not serve under an access policy guuey.json does not declare.`);
  warn(ACCESS_DOOR_LINE);
  return { kind: 'refused', message };
}
