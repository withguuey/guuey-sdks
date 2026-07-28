/**
 * Pins the `guuey widget keys revoke` --help section against the same
 * regression `commands/widget.test.ts` guards its prompt and non-interactive
 * refusal against (T16 review I1): the copy must never again claim
 * revocation is permanent or that there is no un-revoke. `widget keys
 * create` deliberately re-enrols a revoked row with a fresh key, and
 * end-users keep their identity — this help text is what a builder reads
 * BEFORE deciding to revoke, so it has to say so.
 *
 * Reads `cli.ts` as TEXT rather than importing it: the module runs
 * `checkForUpdate()` (a network call) as a side effect of being the CLI
 * entrypoint, at import time — a test must not trigger that just to check a
 * help string.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI_SOURCE = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

function section(startLabel: string, endLabel: string): string {
  const start = CLI_SOURCE.indexOf(startLabel);
  if (start === -1) {
    throw new Error(`cli.ts: help text ${JSON.stringify(startLabel)} not found`);
  }
  const end = CLI_SOURCE.indexOf(endLabel, start);
  if (end === -1) {
    throw new Error(`cli.ts: help text end marker ${JSON.stringify(endLabel)} not found`);
  }
  return CLI_SOURCE.slice(start, end);
}

const revokeHelp = section('widget keys revoke [appId]', '\n\nConfiguration:');

describe('cli.ts --help — widget keys revoke section', () => {
  it('does not claim revocation is permanent or that there is no un-revoke', () => {
    expect(revokeHelp).not.toMatch(
      /permanent|no un-revoke|cannot be undone|cannot be restored/i,
    );
  });

  it('states the ratified semantics: unpublishes the JWKS and names the way back', () => {
    expect(revokeHelp).toMatch(/unpublish/i);
    expect(revokeHelp).toMatch(/widget\s+keys create/i);
    expect(revokeHelp).toMatch(/keep(s)? their identity/i);
  });
});
