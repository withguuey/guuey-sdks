/**
 * SYNC GUARDS: the CLI's hand-mirrored cliApi wire shapes vs.
 * `@guuey-private/cli-wire`, the single source those shapes are served from
 * (guuey#33).
 *
 * Read `../wire-mirror-parse.ts`'s header first — it explains why the CLI
 * mirrors instead of importing (published npm package, private source
 * package), and why these guards compare field NAMES and OPTIONALITY rather
 * than field types (the CLI widens some types on purpose).
 *
 * Every guard here reads BOTH sides off disk, so drift on either side fails.
 * They skip when `backend/` is absent — a consumer's installed copy of
 * `@guuey/cli` has no monorepo around it, and the monorepo is the only place
 * a divergence can be introduced in the first place.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseInterfaceFields, parseStringLiterals } from '../wire-mirror-parse';

function repoPath(relativeToThisFile: string): string {
  return fileURLToPath(new URL(relativeToThisFile, import.meta.url));
}

const CLI_WIRE_DIR = '../../../../../backend/libs/cli-wire';
const WIRE_APPS = repoPath(`${CLI_WIRE_DIR}/apps.ts`);
const WIRE_MCP = repoPath(`${CLI_WIRE_DIR}/mcp.ts`);
const WIRE_WIDGET_KEYS = repoPath(`${CLI_WIRE_DIR}/widget-keys.ts`);
const WIRE_DEPLOY = repoPath(`${CLI_WIRE_DIR}/deploy.ts`);
const WIRE_MCP_CONNECTIONS = repoPath(`${CLI_WIRE_DIR}/mcp-connections.ts`);

const CLI_APPS = repoPath('./apps.ts');
const CLI_MCP = repoPath('./mcp.ts');
const CLI_WIDGET = repoPath('./widget.ts');
const CLI_AGENT = repoPath('./agent.ts');
const CLI_MCP_CONNECTIONS = repoPath('./mcp-connections.ts');

const haveWire =
  existsSync(WIRE_APPS) &&
  existsSync(WIRE_MCP) &&
  existsSync(WIRE_WIDGET_KEYS) &&
  existsSync(WIRE_DEPLOY) &&
  existsSync(WIRE_MCP_CONNECTIONS);
const read = (path: string): string => readFileSync(path, 'utf8');

/** Field names only — the shared assertion for "these two declare the same members". */
function fieldNames(source: string, name: string): string[] {
  return parseInterfaceFields(source, name).map((field) => field.name);
}

describe.skipIf(!haveWire)('CLI wire mirrors — sync guards against @guuey-private/cli-wire', () => {
  it('McpServerListItem declares exactly the wire fields, with the same optionality', () => {
    // `guuey mcp list` renders every one of these columns. A field renamed
    // server-side and not here is a blank column, silently — the exact bug
    // `apps.ts`'s `displayName` comment records (S5).
    expect(parseInterfaceFields(read(CLI_MCP), 'McpServerListItem')).toEqual(
      parseInterfaceFields(read(WIRE_MCP), 'McpServerListItem'),
    );
  });

  it('the three widget-key ceremony responses declare exactly the wire fields', () => {
    // The CLI names them `WidgetKeyCreated`/`Rotated`/`Revoked`; the wire
    // names them `…Response`. Same shapes, different local nouns.
    const cli = read(CLI_WIDGET);
    const wire = read(WIRE_WIDGET_KEYS);
    expect(parseInterfaceFields(cli, 'WidgetCurrentAuth')).toEqual(
      parseInterfaceFields(wire, 'WidgetCurrentAuth'),
    );
    expect(parseInterfaceFields(cli, 'WidgetKeyCreated')).toEqual(
      parseInterfaceFields(wire, 'WidgetKeyCreateResponse'),
    );
    expect(parseInterfaceFields(cli, 'WidgetKeyRotated')).toEqual(
      parseInterfaceFields(wire, 'WidgetKeyRotateResponse'),
    );
    expect(parseInterfaceFields(cli, 'WidgetKeyRevoked')).toEqual(
      parseInterfaceFields(wire, 'WidgetKeyRevokeResponse'),
    );
  });

  it('AppSummary/AppDetail read a SUBSET of AppWire — every field it reads exists', () => {
    // Not equality: `guuey apps` deliberately prints a few of `AppWire`'s
    // fields and ignores the rest (ownerKind, userId, status, …). What must
    // hold is that nothing the CLI reads has been renamed or dropped from
    // the wire — a field present here and absent there prints `undefined`.
    const wireFields = new Set(fieldNames(read(WIRE_APPS), 'AppWire'));
    const cli = read(CLI_APPS);
    // `AppDetail extends AppSummary`, so the two together are what the CLI reads.
    for (const field of [...fieldNames(cli, 'AppSummary'), ...fieldNames(cli, 'AppDetail')]) {
      expect(wireFields).toContain(field);
    }
  });

  it('UpdateAppRequest sends only fields UpdateAppBody accepts', () => {
    // Subset, not equality. The dangerous direction is a field the CLI SENDS
    // that the handler does not read — silently dropped, which is how every
    // flag of `guuey apps update` once 400'd with "No updatable fields
    // provided" (see `UpdateAppRequest`'s docblock). This catches that.
    //
    // The other direction is a capability gap, not drift: the handler also
    // accepts `guestAccess` / `guestDailyMessageLimit`, for which the CLI has
    // no flags — those are Console-managed today. Asserting equality would
    // make that gap a red test with no bug behind it.
    const accepted = new Set(fieldNames(read(WIRE_APPS), 'UpdateAppBody'));
    for (const field of fieldNames(read(CLI_APPS), 'UpdateAppRequest')) {
      expect(accepted).toContain(field);
    }
  });

  it('AgentConfig declares exactly the AgentConfigWire fields, with the same optionality', () => {
    // `guuey agent config` renders every one of these. Equality, not subset:
    // the wire is four fields the command exists to print, so a field added
    // server-side and not here is a knob the CLI silently never shows.
    expect(parseInterfaceFields(read(CLI_AGENT), 'AgentConfig')).toEqual(
      parseInterfaceFields(read(WIRE_DEPLOY), 'AgentConfigWire'),
    );
  });

  it('MCP_SIZES is exactly the wire McpServerSize union', () => {
    expect(parseStringLiterals(read(CLI_MCP), 'MCP_SIZES')).toEqual(
      parseStringLiterals(read(WIRE_MCP), 'McpServerSize'),
    );
  });

  it('the OAuth-broker connection mirrors declare exactly the wire fields (guuey#178 Slice 5)', () => {
    // `guuey mcp connections` renders these; `guuey mcp connect` reads the
    // start answer. Equality on every one — a renamed field is a blank
    // column or a broken authorize link, silently.
    const cli = read(CLI_MCP_CONNECTIONS);
    const wire = read(WIRE_MCP_CONNECTIONS);
    for (const name of ['McpAttachmentWire', 'McpConnectionWire', 'McpConnectionsWire', 'McpConnectStartWire']) {
      expect(parseInterfaceFields(cli, name)).toEqual(parseInterfaceFields(wire, name));
    }
  });
});
