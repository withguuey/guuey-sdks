import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseInterfaceFields, parseStringLiterals } from './wire-mirror-parse';
import { APP_UPDATE_WARNING_CODES, updateWarningsOf } from './update-warnings';

const WIRE_APPS = fileURLToPath(new URL('../../../../backend/libs/cli-wire/apps.ts', import.meta.url));
const CLI_MIRROR = fileURLToPath(new URL('./update-warnings.ts', import.meta.url));
/**
 * The wire source exists only in the monorepo; the published mirror and an
 * installed copy carry no `backend/`, so the comparison skips there (the rule
 * `commands/wire-sync.test.ts` states in its header).
 */
const haveWire = existsSync(WIRE_APPS);

describe('update warnings (guuey#2515) — the CLI mirror of cli-wire', () => {
  it.skipIf(!haveWire)('APP_UPDATE_WARNING_CODES is exactly the wire list, in order', () => {
    expect([...APP_UPDATE_WARNING_CODES]).toEqual(
      parseStringLiterals(readFileSync(WIRE_APPS, 'utf8'), 'APP_UPDATE_WARNING_CODES'),
    );
  });

  it.skipIf(!haveWire)('AppUpdateWarningWire has the wire fields, with the same optionality', () => {
    expect(parseInterfaceFields(readFileSync(CLI_MIRROR, 'utf8'), 'AppUpdateWarningWire')).toEqual(
      parseInterfaceFields(readFileSync(WIRE_APPS, 'utf8'), 'AppUpdateWarningWire'),
    );
  });

  it('reads every entry with a string code and a message, a code this CLI does not know included', () => {
    expect(
      updateWarningsOf({
        app: {},
        warnings: [
          { code: 'BYO_ISSUER_MISSING', message: 'a' },
          { code: 'SOME_NEWER_CODE', message: 'b' },
        ],
      }),
    ).toEqual([
      { code: 'BYO_ISSUER_MISSING', message: 'a' },
      { code: 'SOME_NEWER_CODE', message: 'b' },
    ]);
  });

  it('reads an absent, non-array or malformed field as no warnings, entry by entry', () => {
    expect(updateWarningsOf({ app: {} })).toEqual([]);
    expect(updateWarningsOf({ warnings: 'nope' })).toEqual([]);
    expect(updateWarningsOf(undefined)).toEqual([]);
    expect(updateWarningsOf('nope')).toEqual([]);
    expect(
      updateWarningsOf({ warnings: [null, { code: 1, message: 'x' }, { code: 'C', message: '' }, { code: 'C', message: 'kept' }] }),
    ).toEqual([{ code: 'C', message: 'kept' }]);
  });
});
