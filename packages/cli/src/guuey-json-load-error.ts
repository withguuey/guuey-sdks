/**
 * How the CLI words a failure to load `guuey.json` (guuey#2851).
 *
 * The CLI is the file's author, so its parse stays strict: an unknown key is
 * refused, because here it is most often a typo. It can also be a setting
 * from a newer guuey.json (written by a newer CLI, or copied from newer
 * docs), and then the remedy is an upgrade, not an edit. The refusal says
 * both in one line.
 */
import { guueyJsonUnknownKeys } from '@guuey/config';

/** The upgrade line added under a refusal that names an unknown key. */
export function unknownKeyHint(keys: readonly string[]): string {
  const one = keys.length === 1;
  return (
    `Unknown key${one ? '' : 's'} in guuey.json: ${keys.join(', ')}. ` +
    `If ${one ? 'it is a typo, fix it; if it comes' : 'they are typos, fix them; if they come'} ` +
    'from a newer guuey.json, upgrade @guuey/cli (npm i -g @guuey/cli@latest).'
  );
}

/** The message for an error thrown while loading `guuey.json`, with the hint when a key was unknown. */
export function guueyJsonLoadErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const keys = guueyJsonUnknownKeys(err);
  return keys.length === 0 ? message : `${message}\n${unknownKeyHint(keys)}`;
}
