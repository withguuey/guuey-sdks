/**
 * guuey#1084 — the look, at the moment the builder is looking.
 *
 * One line after `Live at <url>` when the app renders the guuey theme (no
 * `chatTheme` of its own), naming the two write paths — the console's
 * Design → Chat theme and `app.theme` in guuey.json + `guuey agent apply`.
 * Nothing else on the post-deploy screens (console chip, CLI) reached the
 * theme before this; a builder who wanted the widget to look like their
 * product had to know the Design tab existed.
 *
 * Silent in every other case, on purpose: when the app HAS a theme; when
 * the read is not the app projection (`chatTheme` absent rather than
 * `null` — `null` is the wire's positive statement, `undefined` is "not
 * that shape"); when the read fails or is not JSON. A hint never fails a
 * successful deploy and never prints on a guess.
 */
import { apiRequest } from '../deploy-shared';

export const THEME_HINT_LINES: readonly string[] = [
  '  Look:   the chat panel renders the Guuey theme. Make it yours in the console',
  '          (Design → Chat theme), or add app.theme to guuey.json and run `guuey agent apply`.',
];

export async function maybePrintThemeHint(
  pat: string,
  config: { apiUrl?: string },
  appId: string,
  deps?: { api?: typeof apiRequest; log?: (line: string) => void },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const log = deps?.log ?? ((line: string) => console.log(line));
  let chatTheme: unknown;
  try {
    const res = await api(pat, config, 'GET', `/apps/${appId}`);
    if (!res.ok) return;
    const wire = (await res.json()) as { chatTheme?: unknown };
    chatTheme = wire.chatTheme;
  } catch {
    // The deploy already succeeded; an optional hint must not turn a
    // transport or parse error into output. Silence IS the correct
    // rendering of "unknown" here (see the module doc).
    return;
  }
  if (chatTheme !== null) return;
  log('');
  for (const line of THEME_HINT_LINES) log(line);
}
