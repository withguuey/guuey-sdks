import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStringLiterals } from './wire-mirror-parse';
import { readThemeForward, THEME_FORWARD_STATUSES, themeForwardLines, themeForwardOf } from './theme-forward';

const WIRE_APPS = fileURLToPath(new URL('../../../../backend/libs/cli-wire/apps.ts', import.meta.url));
/**
 * The monorepo is the only place the two sides can drift, and the only place
 * the wire source exists: the published mirror and a consumer's installed copy
 * carry no `backend/`. The comparison skips there rather than failing on a file
 * it cannot have — the rule `commands/wire-sync.test.ts` states in its header,
 * missed here and caught by the mirror's own CI and the extract gate (guuey#1406).
 */
const haveWire = existsSync(WIRE_APPS);

/**
 * guuey#1415 — the public CLI mirrors cli-wire's `ThemeForwardWire`; the
 * mirror is pinned against the wire SOURCE so a status added on one side
 * without the other fails here, not in a builder's terminal.
 */
describe('theme-forward (guuey#1415) — the CLI mirror of cli-wire', () => {
  it.skipIf(!haveWire)('THEME_FORWARD_STATUSES is exactly the wire union, in order', () => {
    expect([...THEME_FORWARD_STATUSES]).toEqual(parseStringLiterals(readFileSync(WIRE_APPS, 'utf8'), 'THEME_FORWARD_STATUSES'));
  });

  it('readThemeForward narrows like the wire reader; themeForwardOf reads the field off a body', () => {
    expect(readThemeForward({ status: 'refused', reason: 'x', wouldDrop: ['a'] })).toEqual({ status: 'refused', reason: 'x', wouldDrop: ['a'] });
    expect(readThemeForward({ status: 'refused', reason: '', wouldDrop: ['a', 1] })).toEqual({ status: 'refused' });
    expect(readThemeForward({ status: 'nope' })).toBeUndefined();
    expect(readThemeForward(undefined)).toBeUndefined();
    expect(themeForwardOf({ app: {}, themeForward: { status: 'deferred' } })).toEqual({ status: 'deferred' });
    expect(themeForwardOf({ app: {} })).toBeUndefined();
    expect(themeForwardOf('nope')).toBeUndefined();
  });

  it('themeForwardLines: nothing for forwarded / absent; the held members on refused; one line each for deferred and failed', () => {
    expect(themeForwardLines(undefined)).toEqual([]);
    expect(themeForwardLines({ status: 'forwarded' })).toEqual([]);
    const refused = themeForwardLines({ status: 'refused', wouldDrop: ['cssVariables', 'keyframes'] });
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain('it holds cssVariables, keyframes that guuey does not write');
    expect(themeForwardLines({ status: 'refused' })[0]).toContain('members this write does not carry');
    expect(themeForwardLines({ status: 'deferred', reason: 'cleared' })).toEqual([
      '  Cards:  saved here — the card side keeps its last theme until a member-level clear exists on the ggui side.',
    ]);
    expect(themeForwardLines({ status: 'failed', reason: 'HTTP 503' })[0]).toContain('could not be reached (HTTP 503)');
  });
});
