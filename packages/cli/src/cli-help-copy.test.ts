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

// guuey#933: `--max-pods` on its own runs the app as a FIXED count (the
// guuey#752 derivation — a hand-set count with no scaling mode chosen is
// `fixed`, the auto-scaler off). The help is what a builder reads BEFORE the
// write, so both entries say so and name the knob that keeps the number a
// ceiling — and the `--scaling` knob itself is listed, which it was not.
const deployMaxPodsHelp = section(
  '--max-pods <n>               How many pods',
  '--runtime-auto-update on|off Runtime image',
);
const agentConfigHelp = section(
  'agent config                   Show',
  '--runtime-auto-update on|off Automatic',
);

describe('cli.ts --help — --max-pods names the scaling regime it lands (guuey#933)', () => {
  it('deploy --max-pods: a fixed count unless a scaling mode is chosen, and the way to keep it a ceiling', () => {
    expect(deployMaxPodsHelp).toMatch(/fixed/);
    expect(deployMaxPodsHelp).toMatch(/auto-scaler is off/);
    expect(deployMaxPodsHelp).toMatch(/--scaling auto/);
  });

  it('agent config --max-pods: the same rule, with --scaling auto|fixed documented beside it', () => {
    expect(agentConfigHelp).toMatch(/--max-pods[\s\S]*auto-scaler is off[\s\S]*--scaling auto/);
    expect(agentConfigHelp).toMatch(/--scaling auto\|fixed/);
  });
});
