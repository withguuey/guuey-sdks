/**
 * The `warnings` a `PUT /v1/apps/:id` answer can carry (guuey#2515) — the
 * public CLI's MIRROR of `@guuey-private/cli-wire`'s `AppUpdateWarningWire`
 * and `APP_UPDATE_WARNING_CODES` (`backend/libs/cli-wire/apps.ts`; the CLI
 * cannot take the private dep). `update-warnings.test.ts` pins both against
 * the wire source.
 *
 * A warning never refuses: the write is already done. The server composes the
 * `message`, so the CLI prints it verbatim and keeps no text of its own per
 * code. The field is absent when there is nothing to say (and on an older
 * server). A code this CLI does not know still prints its message, so a newer
 * server's warning reaches an older CLI.
 */
export const APP_UPDATE_WARNING_CODES = ['BYO_ISSUER_MISSING'] as const;

/**
 * One `warnings` entry. `code` is typed as a plain string, not the code union,
 * on purpose: an unknown code is read, not dropped.
 */
export interface AppUpdateWarningWire {
  code: string;
  message: string;
}

/**
 * Read `warnings` off a parsed answer body. Entries without a string `code`
 * and a non-empty string `message` are skipped; anything that is not an array
 * reads as no warnings.
 */
export function updateWarningsOf(body: unknown): AppUpdateWarningWire[] {
  if (body === null || typeof body !== 'object') return [];
  const raw = (body as { warnings?: unknown }).warnings;
  if (!Array.isArray(raw)) return [];
  const out: AppUpdateWarningWire[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const { code, message } = entry as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && typeof message === 'string' && message !== '') {
      out.push({ code, message });
    }
  }
  return out;
}
