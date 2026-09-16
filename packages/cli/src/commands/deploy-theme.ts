/**
 * guuey#1130 G59 — `app.theme` in guuey.json reaches a CODE app on
 * `guuey deploy`.
 *
 * Before this, theme-as-code had one door: `guuey agent apply` converged
 * `app.theme` for declarative apps, and a code app that carried the same
 * block ran `guuey deploy`, which read no theme at all — the block was
 * silently ignored and nothing said so (the audit's G59). Now the code
 * path, after `Live at <url>`, writes the theme through THE SAME DOOR
 * `guuey apps update --chat-theme-file` uses: `PUT /apps/:id { chatTheme }`,
 * validated server-side by the one chat-theme gate (a bad token is a 400
 * naming the path). A `{ file }` reference is resolved by the config loader
 * exactly as `agent apply` resolves it.
 *
 * THE RULE — first write for free, a rewrite is explicit: `deploy` applies
 * `app.theme` only when the app has NO chat theme yet (`chatTheme: null` on
 * the app projection, the same read the "Look:" hint makes). An existing
 * theme — the console's, or a previous write — is NEVER overwritten by a
 * deploy: shipping code is not the moment to replace a look someone set,
 * and a stale block in guuey.json must not win over the console on an
 * unrelated redeploy (oss's cut review named the case). The line then
 * names the explicit doors that DO rewrite: `guuey apps update
 * --chat-theme-file` and the console. When the current state cannot be
 * read, nothing is written — a blind write could be that overwrite.
 *
 * Posture: a second write after a deploy that already succeeded. It never
 * fails the deploy — a refused theme is a loud line naming the field and the
 * door, never a red build for an app that is live — and it never prints on
 * a guess: no `app.theme` → nothing sent, nothing said.
 */
import { isThemeFileRef, type GuueyAppTheme, type ResolvedGuueyJson } from '@guuey/config';
import { apiRequest, parseApiError } from '../deploy-shared';

export const THEME_APPLIED_LINE =
  '  Theme:  app.theme applied — the same write as `guuey apps update --chat-theme-file`.';
export const THEME_DOOR_LINE =
  '          Other doors for the same document: `guuey apps update <app> --chat-theme-file <file>`, or the console (Design → Chat theme).';
export const THEME_KEPT_LINE =
  '  Theme:  app.theme in guuey.json was not applied — this app already has a chat theme (the console\'s, or an earlier write), and a deploy never overwrites it.';
export const THEME_KEPT_DOOR_LINE =
  '          To make the file win: `guuey apps update <app> --chat-theme-file <file>` (or set it in the console, Design → Chat theme).';

export type ApplyThemeOutcome = 'none' | 'applied' | 'kept' | 'refused' | 'failed';

/** The theme document guuey.json states for the app — inline, or the resolved `{ file }` — else undefined. */
export function themeFromConfig(loaded: Pick<ResolvedGuueyJson, 'doc' | 'resolvedTheme'>): GuueyAppTheme | undefined {
  const theme = loaded.doc.app?.theme;
  if (theme === undefined) return undefined;
  return isThemeFileRef(theme) ? loaded.resolvedTheme : theme;
}

export async function maybeApplyThemeFromConfig(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  loaded: Pick<ResolvedGuueyJson, 'doc' | 'resolvedTheme'>,
  deps?: { api?: typeof apiRequest; log?: (line: string) => void; warn?: (line: string) => void },
): Promise<ApplyThemeOutcome> {
  const theme = themeFromConfig(loaded);
  if (theme === undefined) return 'none';
  const api = deps?.api ?? apiRequest;
  const log = deps?.log ?? ((line: string) => console.log(line));
  const warn = deps?.warn ?? ((line: string) => console.error(line));
  // Read the app's current theme first — the same projection the "Look:"
  // hint reads (`chatTheme` is present ONLY when the app configured one;
  // `null` is the wire's positive "none"; absent means "not that shape").
  let current: unknown;
  try {
    const read = await api(pat, config, 'GET', `/apps/${appId}`);
    if (!read.ok) throw new Error(`HTTP ${read.status} reading the app`);
    current = (await read.json()) as unknown;
  } catch (err) {
    warn(`  Theme:  app.theme was NOT applied — could not read the app's current theme (${err instanceof Error ? err.message : String(err)}); nothing written.`);
    warn(THEME_DOOR_LINE);
    return 'failed';
  }
  const stored = current !== null && typeof current === 'object' && 'chatTheme' in current ? (current as { chatTheme: unknown }).chatTheme : undefined;
  if (stored !== null) {
    // undefined = not the app projection — unknown, so no blind write either.
    warn(THEME_KEPT_LINE);
    warn(THEME_KEPT_DOOR_LINE);
    return 'kept';
  }
  let res: Response;
  try {
    res = await api(pat, config, 'PUT', `/apps/${appId}`, { chatTheme: theme });
  } catch (err) {
    warn(`  Theme:  app.theme was NOT applied — ${err instanceof Error ? err.message : String(err)}`);
    warn(THEME_DOOR_LINE);
    return 'failed';
  }
  if (res.ok) {
    log(THEME_APPLIED_LINE);
    return 'applied';
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  warn(`  Theme:  app.theme was NOT applied — ${parseApiError(body, `HTTP ${res.status}`)}`);
  warn(THEME_DOOR_LINE);
  return res.status >= 400 && res.status < 500 ? 'refused' : 'failed';
}
