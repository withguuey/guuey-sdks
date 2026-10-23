/**
 * The tool-gate contract (`tool-gates.ts`), as one table run against both
 * shapes of the gate: the per-server predicate and the Claude Agent SDK
 * rules. Each row names the gates, this turn's withholds, and the tools the
 * model keeps on two attached servers, `a` and `b`, each listing the same
 * three tools.
 */
import { describe, expect, it } from 'vitest';
import {
  claudeToolRules,
  toolGateErrors,
  toolGatePredicate,
  type ToolGateWithhold,
  type ToolGates,
} from './tool-gates.js';

const SERVERS = ['a', 'b'] as const;
const TOOLS = ['read', 'write', 'search'] as const;

/** A tool on a server, as `server.tool`. */
type Kept = `${(typeof SERVERS)[number]}.${(typeof TOOLS)[number]}`;

const EVERY: Kept[] = SERVERS.flatMap((s) => TOOLS.map((t): Kept => `${s}.${t}`));

interface Row {
  label: string;
  gates: ToolGates;
  withheld?: ToolGateWithhold[];
  kept: Kept[];
}

const ROWS: Row[] = [
  { label: 'no gates', gates: undefined, kept: EVERY },
  { label: 'empty gate block', gates: {}, kept: EVERY },
  { label: '[] reads like absent', gates: { allowlist: [], denylist: [] }, kept: EVERY },
  { label: 'allow-only, one tool', gates: { allowlist: ['a.read'] }, kept: ['a.read'] },
  { label: 'allow-only, server.*', gates: { allowlist: ['a.*'] }, kept: ['a.read', 'a.write', 'a.search'] },
  { label: 'allow-only, bare fans out', gates: { allowlist: ['search'] }, kept: ['a.search', 'b.search'] },
  { label: 'deny-only, one tool', gates: { denylist: ['a.write'] }, kept: EVERY.filter((k) => k !== 'a.write') },
  { label: 'deny-only, bare fans out', gates: { denylist: ['write'] }, kept: EVERY.filter((k) => !k.endsWith('.write')) },
  { label: 'deny-only, server.*', gates: { denylist: ['b.*'] }, kept: ['a.read', 'a.write', 'a.search'] },
  {
    label: 'allow + deny overlap: deny wins',
    gates: { allowlist: ['a.*', 'b.read'], denylist: ['a.write', 'b.read'] },
    kept: ['a.read', 'a.search'],
  },
  { label: '@none keeps no MCP tool', gates: { allowlist: ['@none'] }, kept: [] },
  { label: '@none mixed: only the real entries count', gates: { allowlist: ['@none', 'b.read'] }, kept: ['b.read'] },
  { label: '@none in a denylist subtracts nothing', gates: { denylist: ['@none'] }, kept: EVERY },
  {
    label: 'withheld subtracts',
    gates: undefined,
    withheld: [{ server: 'a', tool: 'search' }],
    kept: EVERY.filter((k) => k !== 'a.search'),
  },
  {
    label: 'allow, then deny, then withheld',
    gates: { allowlist: ['a.*'], denylist: ['a.write'] },
    withheld: [{ server: 'a', tool: 'search' }],
    kept: ['a.read'],
  },
  {
    label: 'unparseable allow entry is dropped',
    gates: { allowlist: ['mcp__a__read', 'a.write'] },
    kept: ['a.write'],
  },
  { label: 'unparseable deny entry keeps no MCP tool', gates: { denylist: ['mcp__a__write'] }, kept: [] },
  {
    label: 'unparseable deny entry beside readable ones keeps no MCP tool',
    gates: { allowlist: ['a.*'], denylist: ['b.read', 'a.wr*te'] },
    kept: [],
  },
  { label: 'stored allowlist "*" = every tool', gates: { allowlist: ['*'] }, kept: EVERY },
  { label: 'stored allowlist "*" beside entries = every tool', gates: { allowlist: ['a.read', ' * '] }, kept: EVERY },
  { label: 'stored denylist "*" = @none', gates: { denylist: ['*'] }, kept: [] },
  { label: 'stored denylist "*" beats an allowlist', gates: { allowlist: ['a.*'], denylist: ['*'] }, kept: [] },
];

/** The kept set through the per-server predicate. */
function keptByPredicate(row: Row): Kept[] {
  return SERVERS.flatMap((server) => {
    const keep = toolGatePredicate(row.gates, server, row.withheld);
    return TOOLS.filter((tool) => keep === undefined || keep(tool)).map((tool): Kept => `${server}.${tool}`);
  });
}

/**
 * The kept set through the Claude rules, read the way the SDK does: a tool is
 * offered unless a disallow rule names it (`mcp__<s>` or `mcp__<s>__<t>`), and
 * a call to it then passes when an allow rule names it or the permission check
 * allows it.
 */
async function keptByClaudeRules(row: Row): Promise<Kept[]> {
  const rules = claudeToolRules(row.gates, SERVERS, { builtins: [], withheld: row.withheld });
  const names = (rule: string, server: string, tool: string): boolean =>
    rule === `mcp__${server}` || rule === `mcp__${server}__${tool}`;
  const kept: Kept[] = [];
  for (const server of SERVERS) {
    for (const tool of TOOLS) {
      if (rules.disallowedTools.some((r) => names(r, server, tool))) continue;
      if (rules.allowedTools.some((r) => names(r, server, tool))) {
        kept.push(`${server}.${tool}`);
        continue;
      }
      const verdict = await rules.canUseTool(`mcp__${server}__${tool}`, { k: 'v' });
      if (verdict.behavior === 'allow') kept.push(`${server}.${tool}`);
    }
  }
  return kept;
}

describe('the tool-gate contract, one table, both shapes', () => {
  for (const row of ROWS) {
    it(`predicate: ${row.label}`, () => {
      expect(keptByPredicate(row)).toEqual(row.kept);
    });
    it(`Claude rules: ${row.label}`, async () => {
      expect(await keptByClaudeRules(row)).toEqual(row.kept);
    });
  }
});

describe('toolGatePredicate', () => {
  it('returns undefined (no filter) when nothing narrows, denies or withholds on that server', () => {
    expect(toolGatePredicate(undefined, 'a')).toBeUndefined();
    expect(toolGatePredicate({ allowlist: ['a.*'], denylist: ['b.read'] }, 'a')).toBeUndefined();
    expect(toolGatePredicate({ allowlist: ['*'] }, 'a')).toBeUndefined();
    expect(toolGatePredicate(undefined, 'a', [{ server: 'b', tool: 'read' }])).toBeUndefined();
  });

  it('never matches the "@none" sentinel as a tool name', () => {
    expect(toolGatePredicate({ allowlist: ['@none', 'search'] }, 'a')?.('@none')).toBe(false);
  });
});

describe('claudeToolRules', () => {
  it('spells every rule the SDK way, never the config grammar', () => {
    const rules = claudeToolRules({ allowlist: ['a.read', 'b.*', 'search'], denylist: ['write'] }, SERVERS, {
      builtins: [],
    });
    expect(rules.allowedTools).toEqual(['mcp__a__read', 'mcp__b', 'mcp__a__search', 'mcp__b__search']);
    expect(rules.disallowedTools).toEqual(['mcp__a__write', 'mcp__b__write']);
    expect(rules.explicitAllowlist).toBe(true);
  });

  it('absent, [] and a stored "*" allowlist: every server allowed whole, the allow-every posture', async () => {
    for (const gates of [undefined, { allowlist: [] }, { allowlist: ['*'] }] satisfies ToolGates[]) {
      const rules = claudeToolRules(gates, SERVERS, { builtins: [] });
      expect(rules.allowedTools).toEqual(['mcp__a', 'mcp__b']);
      expect(rules.explicitAllowlist).toBe(false);
      expect((await rules.canUseTool('mcp__c__anything', {})).behavior).toBe('allow');
    }
  });

  it('an explicit allowlist denies an unlisted pick with a readable message, never an ask', async () => {
    const rules = claudeToolRules({ allowlist: ['a.read'] }, SERVERS, { builtins: [] });
    const verdict = await rules.canUseTool('mcp__b__read', { k: 'v' });
    expect(verdict).toEqual({
      behavior: 'deny',
      message: 'Tool "mcp__b__read" is not in this agent\'s tools.allowlist. Allowed: mcp__a__read.',
    });
    expect(await rules.canUseTool('mcp__a__read', { k: 'v' })).toEqual({ behavior: 'allow', updatedInput: { k: 'v' } });
  });

  it('a stored denylist "*" reads as @none: no MCP allow rule, every server disallowed, built-ins kept', () => {
    const star = claudeToolRules({ denylist: ['*'] }, SERVERS, { builtins: ['Bash'] });
    const none = claudeToolRules({ allowlist: ['@none'] }, SERVERS, { builtins: ['Bash'] });
    expect(star.allowedTools).toEqual(['Bash']);
    expect(star.disallowedTools).toEqual(['mcp__a', 'mcp__b']);
    expect(star.explicitAllowlist).toBe(true);
    expect({ ...star, canUseTool: undefined }).toEqual({ ...none, canUseTool: undefined });
  });

  it('built-ins join the allow rules, and a bare entry naming one names that built-in too', () => {
    const rules = claudeToolRules({ allowlist: ['a.read'], denylist: ['Bash'] }, SERVERS, { builtins: ['Read', 'Bash'] });
    expect(rules.allowedTools).toEqual(['mcp__a__read', 'Read', 'Bash']);
    expect(rules.disallowedTools).toEqual(['mcp__a__Bash', 'mcp__b__Bash', 'Bash']);
  });

  it('withholds on a server not attached this turn change nothing', () => {
    const rules = claudeToolRules(undefined, SERVERS, { builtins: [], withheld: [{ server: 'c', tool: 'read' }] });
    expect(rules.disallowedTools).toEqual([]);
  });
});

describe('toolGateErrors: an unparseable denylist entry fails closed and is named', () => {
  it('names each unreadable denylist entry with the parser reason', () => {
    const errors = toolGateErrors({ allowlist: ['mcp__a__read'], denylist: ['a.read', 'mcp__a__write', '.x'] });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('tools.denylist entry "mcp__a__write" cannot be read');
    expect(errors[0]).toContain('framework-internal spelling');
    expect(errors[1]).toContain('tools.denylist entry ".x" cannot be read');
    expect(errors[1]).toContain('no MCP tool');
  });

  it('reports nothing for readable lists, "@none", a stored "*", or an unreadable ALLOWLIST entry (dropped instead)', () => {
    expect(toolGateErrors(undefined)).toEqual([]);
    expect(toolGateErrors({ allowlist: ['mcp__a__read'], denylist: ['a.read', 'search', 'b.*', '@none', '*'] })).toEqual([]);
  });

  it('the predicate keeps nothing on every server', () => {
    for (const server of SERVERS) {
      expect(toolGatePredicate({ denylist: ['mcp__a__write'] }, server)?.('read')).toBe(false);
    }
  });

  it('the Claude rules carry the errors, disallow every server, and deny an MCP pick with a message naming the entry', async () => {
    const rules = claudeToolRules({ denylist: ['mcp__a__write'] }, SERVERS, { builtins: ['Bash'] });
    expect(rules.errors).toEqual(toolGateErrors({ denylist: ['mcp__a__write'] }));
    expect(rules.allowedTools).toEqual(['Bash']);
    expect(rules.disallowedTools).toEqual(['mcp__a', 'mcp__b']);
    const verdict = await rules.canUseTool('mcp__b__read', {});
    expect(verdict.behavior).toBe('deny');
    expect(verdict.behavior === 'deny' && verdict.message).toContain('"mcp__a__write"');
    expect((await rules.canUseTool('Bash', {})).behavior).toBe('allow');
  });
});
