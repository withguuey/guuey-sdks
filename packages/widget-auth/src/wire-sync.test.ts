/**
 * SYNC GUARD: this package's hand-mirrored mint contract vs.
 * `@guuey-private/cli-wire`'s `widget-token.ts`, the single typed source the
 * cliApi mint route is written against (guuey#206; the CLI's guuey#33 idiom).
 *
 * `@guuey/widget-auth` is published npm and cannot depend on a private
 * workspace lib, so `MintRequestBody` / `WidgetToken` and the path, prefix and
 * field caps are mirrored by hand in `index.ts`. This test reads BOTH sides off
 * disk and compares field names, optionality and literal values, so drift on
 * either side fails here rather than as a customer's 400.
 *
 * Skips when `backend/` is absent: a consumer's installed copy has no monorepo
 * around it, and the monorepo is the only place a divergence can be introduced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WIRE = fileURLToPath(
  new URL('../../../../backend/libs/cli-wire/widget-token.ts', import.meta.url),
);
const MIRROR = fileURLToPath(new URL('./index.ts', import.meta.url));

const haveWire = existsSync(WIRE);
const read = (path: string): string => readFileSync(path, 'utf8');

/** Strip `//` line and block comments so their contents never parse as members. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The declared fields of a FLAT `interface <name> { … }` — name + optionality,
 * sorted by name. Both mint shapes are flat by design (the mint route forwards
 * scalars only), so a brace-matching parser would be over-engineering; a
 * nested member here would fail loudly on the `unparsed member` throw.
 */
function interfaceFields(source: string, name: string): { name: string; optional: boolean }[] {
  const stripped = stripComments(source);
  const match = new RegExp(`(?:export\\s+)?interface\\s+${name}\\b[^{]*\\{([^}]*)\\}`).exec(
    stripped,
  );
  if (match === null || match[1] === undefined) {
    throw new Error(`interface ${name} not found`);
  }
  const fields: { name: string; optional: boolean }[] = [];
  for (const member of match[1].split(';')) {
    if (member.trim().length === 0) continue;
    const parsed = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*:/.exec(member);
    if (parsed === null || parsed[1] === undefined) {
      throw new Error(`unparsed member in interface ${name}: ${member.trim()}`);
    }
    fields.push({ name: parsed[1], optional: parsed[2] === '?' });
  }
  return fields.sort((a, b) => a.name.localeCompare(b.name));
}

/** The literal a `const <name> = <literal>;` declares — a quoted string or a number. */
function constLiteral(source: string, name: string): string | number {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`).exec(
    stripComments(source),
  );
  if (match === null || match[1] === undefined) {
    throw new Error(`const ${name} not found`);
  }
  const raw = match[1].trim();
  const quoted = /^'([^']*)'$/.exec(raw);
  if (quoted !== null && quoted[1] !== undefined) return quoted[1];
  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber)) return asNumber;
  throw new Error(`const ${name} is neither a string nor a number literal: ${raw}`);
}

describe.skipIf(!haveWire)('mint contract mirror — sync guard against @guuey-private/cli-wire', () => {
  it('MintRequestBody declares exactly the wire body fields, with the same optionality', () => {
    expect(interfaceFields(read(MIRROR), 'MintRequestBody')).toEqual(
      interfaceFields(read(WIRE), 'AppUserTokenMintBody'),
    );
  });

  it('WidgetToken declares exactly the wire response fields, with the same optionality', () => {
    expect(interfaceFields(read(MIRROR), 'WidgetToken')).toEqual(
      interfaceFields(read(WIRE), 'AppUserTokenMintResponse'),
    );
  });

  it('the route path, secret prefix and field caps are the wire values', () => {
    const mirror = read(MIRROR);
    const wire = read(WIRE);
    expect(constLiteral(mirror, 'MINT_PATH')).toBe(constLiteral(wire, 'APP_USER_TOKEN_MINT_PATH'));
    expect(constLiteral(mirror, 'SECRET_PREFIX')).toBe(constLiteral(wire, 'APP_SECRET_PREFIX'));
    expect(constLiteral(mirror, 'MAX_USER_ID_LENGTH')).toBe(
      constLiteral(wire, 'APP_USER_TOKEN_MAX_USER_ID_LENGTH'),
    );
    expect(constLiteral(mirror, 'MAX_NAME_LENGTH')).toBe(
      constLiteral(wire, 'APP_USER_TOKEN_MAX_NAME_LENGTH'),
    );
    expect(constLiteral(mirror, 'MAX_EMAIL_LENGTH')).toBe(
      constLiteral(wire, 'APP_USER_TOKEN_MAX_EMAIL_LENGTH'),
    );
  });
});
