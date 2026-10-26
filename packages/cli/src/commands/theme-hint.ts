/**
 * guuey#1084 — the look, at the moment the builder is looking.
 *
 * One line after `Live at <url>` when the app renders the guuey theme (no
 * `chatTheme` of its own), naming the two write paths — the console's
 * Design → Chat theme and `app.theme` in guuey.json (applied by `guuey deploy`
 * for code apps since guuey#1130 G59, and by `guuey agent apply`).
 * Nothing else on the post-deploy screens (console chip, CLI) reached the
 * theme before this; a builder who wanted the widget to look like their
 * product had to know the Design tab existed.
 *
 * Silent in every other case, on purpose: when the app HAS a theme; when
 * the read is not the app projection (no `app`, or `app.chatTheme` absent
 * rather than `null` — `null` is the wire's positive statement, absent is
 * "not that shape"); when the read fails or is not JSON. A hint never fails a
 * successful deploy and never prints on a guess.
 */
import { apiRequest } from '../deploy-shared';
import type { AppDetail } from './apps';

/**
 * What a `GET /apps/:id` body says about the app's chat theme (guuey#2401):
 * `'none'` when the app projection carries `chatTheme: null` (the wire's
 * positive "no theme of its own"), `'set'` when it carries a document, and
 * `'unknown'` for anything that is not that projection.
 *
 * The server answers `{ app, ...verdictField }` (cliApi `handleGetApp`), so
 * the field is read off `body.app` — reading it at the top level of the body
 * made every real answer `'unknown'`, and `guuey deploy` never wrote
 * `app.theme`. The field name is held to the CLI's mirror of the projection
 * (`AppDetail`, pinned to the server's `AppWire` by `wire-sync.test.ts`), and
 * the read narrows the parsed JSON without a cast: this is a presence and
 * `null` test only, never a validation of the theme document.
 */
export type AppChatThemeState = 'none' | 'set' | 'unknown';

const CHAT_THEME_FIELD = 'chatTheme' satisfies keyof AppDetail;

export function appChatThemeState(body: unknown): AppChatThemeState {
  if (typeof body !== 'object' || body === null || !('app' in body)) return 'unknown';
  const app = body.app;
  if (typeof app !== 'object' || app === null || !(CHAT_THEME_FIELD in app)) return 'unknown';
  return app[CHAT_THEME_FIELD] === null ? 'none' : 'set';
}

export const THEME_HINT_LINES: readonly string[] = [
  '  Look:   the chat panel renders the Guuey theme. Make it yours in the console',
  '          (Design → Chat theme), or add app.theme to guuey.json — `guuey deploy` (code apps) and `guuey agent apply` both apply it.',
];

export async function maybePrintThemeHint(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  deps?: { api?: typeof apiRequest; log?: (line: string) => void },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const log = deps?.log ?? ((line: string) => console.log(line));
  // The read goes through `appChatThemeState`, the one reader of the
  // `GET /apps/:id` body's `app.chatTheme` (guuey#2401).
  let state: AppChatThemeState;
  try {
    const res = await api(pat, config, 'GET', `/apps/${appId}`);
    if (!res.ok) return;
    state = appChatThemeState(await res.json());
  } catch {
    // The deploy already succeeded; an optional hint must not turn a
    // transport or parse error into output. Silence IS the correct
    // rendering of "unknown" here (see the module doc).
    return;
  }
  if (state !== 'none') return;
  log('');
  for (const line of THEME_HINT_LINES) log(line);
}
