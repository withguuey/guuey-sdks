/**
 * What the CARD side did after a theme-affecting write (guuey#1415) — the
 * public CLI's MIRROR of `@guuey-private/cli-wire`'s `ThemeForwardWire`
 * (`backend/libs/cli-wire/apps.ts`; the CLI cannot take the private dep).
 * `theme-forward.test.ts` pins the status union against the wire source.
 *
 * `PUT /v1/apps/:id` answers `themeForward` when the write touched `chatTheme`
 * or `brandAccent`; the deploy 202 answers it only when the card side did NOT
 * follow. Absent = nothing to say (an older server, or no theme field).
 */
export const THEME_FORWARD_STATUSES = ['forwarded', 'refused', 'deferred', 'failed'] as const;
export type ThemeForwardStatus = (typeof THEME_FORWARD_STATUSES)[number];

export interface ThemeForwardWire {
  status: ThemeForwardStatus;
  reason?: string;
  wouldDrop?: string[];
}

/** MIRROR of cli-wire's `readThemeForward`: narrow an untrusted field; anything else is "not stated". */
export function readThemeForward(value: unknown): ThemeForwardWire | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const v = value as { status?: unknown; reason?: unknown; wouldDrop?: unknown };
  if (typeof v.status !== 'string' || !(THEME_FORWARD_STATUSES as readonly string[]).includes(v.status)) return undefined;
  const out: ThemeForwardWire = { status: v.status as ThemeForwardStatus };
  if (typeof v.reason === 'string' && v.reason !== '') out.reason = v.reason;
  if (Array.isArray(v.wouldDrop) && v.wouldDrop.every((m) => typeof m === 'string')) out.wouldDrop = v.wouldDrop;
  return out;
}

/** Read the field off a parsed answer body (the PUT `{ app, themeForward? }` or the deploy 202). */
export function themeForwardOf(body: unknown): ThemeForwardWire | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  return readThemeForward((body as { themeForward?: unknown }).themeForward);
}

/**
 * The lines the CLI prints when the card side did not follow — the row write
 * stood, so these never say the save failed; they say what the generated
 * cards will still render. Empty when there is nothing to say.
 */
export function themeForwardLines(forward: ThemeForwardWire | undefined): string[] {
  if (forward === undefined || forward.status === 'forwarded') return [];
  if (forward.status === 'refused') {
    const held = forward.wouldDrop !== undefined && forward.wouldDrop.length > 0 ? forward.wouldDrop.join(', ') : 'members this write does not carry';
    return [
      `  Cards:  saved here — the card side kept its stored theme: it holds ${held} that guuey does not write.`,
      '          Clear them on the ggui side, then save again; the widget already renders the new theme.',
    ];
  }
  if (forward.status === 'deferred') {
    return ['  Cards:  saved here — the card side keeps its last theme until a member-level clear exists on the ggui side.'];
  }
  return [`  Cards:  saved here — the card side could not be reached${forward.reason ? ` (${forward.reason})` : ''}; it keeps its stored theme until the next save.`];
}
