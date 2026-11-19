/**
 * Stored-shape fixtures (guuey#3360): every `guuey.json` shape that names
 * GGUI, as an authored document, with today's result pinned for the load, the
 * tool-gate check and the server resolution, under the default seed and under
 * `{ seedGgui: false }` (guuey#3361). Results are pinned as they are today,
 * including refusals.
 *
 * Both directions:
 *
 * - NEW READS OLD: the current loader and validators read every old shape
 *   below with the pinned result.
 * - OLD READS NEW: the previous release's loader reads the document a new
 *   scaffold writes (the "new scaffold" fixture). When this file landed, this
 *   package's non-test source was identical to the 0.36.0 release cut except
 *   for one comment line in `agent.ts`, so the loader under test here IS that
 *   release's loader, and the "new scaffold" case passing is that direction.
 *
 * Rule for later changes: a change to the loader or validators keeps every
 * case here passing, changing only the expected values it sets out to change,
 * and adds a frozen copy of the then-previous loader (the
 * `src/fixtures/*.prev.ts` pattern of `@guuey/worker`) so the old-reads-new
 * direction stays tested.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_MCP_SERVERS,
  effectiveMcpServers,
  validateToolGates,
  type GuueyAgentMcpServer,
} from './agent.js';
import { parseAuthoredGuueyJson } from './env-placeholders.js';
import {
  assertSupportedGuueyJsonSchema,
  safeParseGuueyJson,
  type GuueyJsonV1,
  type GuueyJsonV1Input,
} from './schema.js';
import { toolGatePredicate } from './tool-gates.js';

// ── Building blocks ─────────────────────────────────────────────────────────

/** The GGUI render URL (the platform default's address). */
const GGUI_RENDER_URL = 'https://mcp.ggui.ai';

/** The platform default as seeded today, written out literally. */
const SEEDED_GGUI: GuueyAgentMcpServer = { kind: 'external', url: GGUI_RENDER_URL, transport: 'http' };

/** An ordinary builder-declared server. */
const TODO: GuueyAgentMcpServer = { kind: 'external', url: 'https://todo.example.com/mcp', transport: 'http' };

/** GGUI declared explicitly, at the render URL, under its own key. */
const DECLARED_GGUI: GuueyAgentMcpServer = { kind: 'external', url: GGUI_RENDER_URL, transport: 'http' };

/** The minimal valid agent section every fixture starts from. */
const BASE_AGENT = { model: 'claude-sonnet-5', systemPrompt: 'You help people plan their week.' } as const;

/** The reserved servers a tool gate may also name, as the message lists them. */
const RESERVED = 'guuey-memory, guuey-profile, guuey-handoff';

// ── What each fixture pins ──────────────────────────────────────────────────

interface Pinned {
  /** `validateToolGates(doc.agent)` and `validateToolGates(doc.agent, { seedGgui: false })`. */
  validate: { seeded: string[]; unseeded: string[] };
  /** `effectiveMcpServers(doc.agent.mcpServers)` and the same under `{ seedGgui: false }`. */
  resolve: { seeded: Record<string, GuueyAgentMcpServer>; unseeded: Record<string, GuueyAgentMcpServer> };
}

/**
 * The loader's own path for an authored document (`readGuueyJsonFile` after
 * `JSON.parse`): the version gate, then the authored-form parse. The document
 * goes through a JSON round trip first, as it would from a file.
 */
function loadAuthored(doc: GuueyJsonV1Input): GuueyJsonV1 {
  const json: unknown = JSON.parse(JSON.stringify(doc));
  assertSupportedGuueyJsonSchema(json);
  return parseAuthoredGuueyJson(json);
}

/** One `describe` per fixture: LOAD, VALIDATE and RESOLVE, each pinned. */
function pinShape(name: string, doc: GuueyJsonV1Input, pinned: Pinned): void {
  describe(name, () => {
    it('LOAD: the loader reads it unchanged (protocol defaulted), and both safe parses succeed with no warnings', () => {
      const loaded = loadAuthored(doc);
      expect(loaded).toEqual({ ...doc, protocol: 'silver' });
      const strict = safeParseGuueyJson(doc);
      expect(strict.success).toBe(true);
      if (strict.success) expect(strict.warnings).toEqual([]);
      const reader = safeParseGuueyJson(doc, { stripUnknownKeys: 'all' });
      expect(reader.success).toBe(true);
      if (reader.success) expect(reader.warnings).toEqual([]);
    });

    it('VALIDATE: validateToolGates, default seed and seedGgui: false', () => {
      const { agent } = loadAuthored(doc);
      expect(validateToolGates(agent)).toEqual(pinned.validate.seeded);
      expect(validateToolGates(agent, { seedGgui: false })).toEqual(pinned.validate.unseeded);
    });

    it('RESOLVE: effectiveMcpServers, default seed and seedGgui: false', () => {
      const { agent } = loadAuthored(doc);
      expect(effectiveMcpServers(agent.mcpServers)).toEqual(pinned.resolve.seeded);
      expect(effectiveMcpServers(agent.mcpServers, { seedGgui: false })).toEqual(pinned.resolve.unseeded);
    });
  });
}

// ── The seed itself ─────────────────────────────────────────────────────────

describe('the platform default seed today', () => {
  it('is GGUI at the render URL under the key "ggui"', () => {
    expect(DEFAULT_AGENT_MCP_SERVERS).toEqual({ ggui: SEEDED_GGUI });
  });
});

// ── 1. The opt-out ──────────────────────────────────────────────────────────

pinShape('1. mcpServers: { ggui: false } (the opt-out)', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { ggui: false } },
}, {
  validate: { seeded: [], unseeded: [] },
  resolve: { seeded: {}, unseeded: {} },
});

// ── 2. GGUI declared explicitly ─────────────────────────────────────────────

pinShape('2. mcpServers.ggui declared as an external server at the render URL', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { ggui: DECLARED_GGUI } },
}, {
  validate: { seeded: [], unseeded: [] },
  resolve: { seeded: { ggui: DECLARED_GGUI }, unseeded: { ggui: DECLARED_GGUI } },
});

// ── 3. The render URL under a renamed key ───────────────────────────────────

pinShape('3. the render URL under a renamed key (mcp-ggui-protocol) suppresses the seed', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { 'mcp-ggui-protocol': DECLARED_GGUI } },
}, {
  validate: { seeded: [], unseeded: [] },
  resolve: {
    seeded: { 'mcp-ggui-protocol': DECLARED_GGUI },
    unseeded: { 'mcp-ggui-protocol': DECLARED_GGUI },
  },
});

// ── 4. The top-level ggui section, each form ────────────────────────────────

/** The top-level section does not touch the server map: the seed still applies. */
const SECTION_ONLY: Pinned = {
  validate: { seeded: [], unseeded: [] },
  resolve: { seeded: { ggui: SEEDED_GGUI }, unseeded: {} },
};

pinShape('4a. top-level ggui: { appId }', {
  schema: '1',
  agent: { ...BASE_AGENT },
  ggui: { appId: 'weekly-planner_01' },
}, SECTION_ONLY);

pinShape('4b. top-level ggui: { configFile }', {
  schema: '1',
  agent: { ...BASE_AGENT },
  ggui: { configFile: './ggui.json' },
}, SECTION_ONLY);

pinShape('4c. top-level ggui: { inline }', {
  schema: '1',
  agent: { ...BASE_AGENT },
  ggui: { inline: { slug: 'weekly-planner', gadgets: ['calendar'] } },
}, SECTION_ONLY);

describe('4d. top-level ggui with both configFile and inline (refused today)', () => {
  const doc: GuueyJsonV1Input = {
    schema: '1',
    agent: { ...BASE_AGENT },
    ggui: { configFile: './ggui.json', inline: { slug: 'weekly-planner' } },
  };

  it('LOAD: the loader refuses it, and the safe parse names the ggui path', () => {
    expect(() => loadAuthored(doc)).toThrow('`ggui` cannot specify both `configFile` and `inline` — pick one');
    const result = safeParseGuueyJson(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))).toEqual([
        { path: ['ggui'], message: '`ggui` cannot specify both `configFile` and `inline` — pick one' },
      ]);
    }
  });
});

// ── 5. Tool gates naming ggui ───────────────────────────────────────────────

const GGUI_ALL_ALLOW = { allowlist: ['ggui.*'] };
const GGUI_TOOL_ALLOW = { allowlist: ['ggui.render_ui', 'todo.create_task'] };
const GGUI_ALL_DENY = { denylist: ['ggui.*'] };
const GGUI_TOOL_DENY = { denylist: ['ggui.render_ui'] };

pinShape('5a. allowlist ["ggui.*"], no declared servers', {
  schema: '1',
  agent: { ...BASE_AGENT, tools: GGUI_ALL_ALLOW },
}, {
  validate: {
    seeded: [],
    unseeded: [
      `tools.allowlist: "ggui.*" names MCP server "ggui", which this agent does not connect — declare it under mcpServers or use one of: ${RESERVED}`,
    ],
  },
  resolve: { seeded: { ggui: SEEDED_GGUI }, unseeded: {} },
});

pinShape('5b. allowlist ["ggui.render_ui", "todo.create_task"], todo declared', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { todo: TODO }, tools: GGUI_TOOL_ALLOW },
}, {
  validate: {
    seeded: [],
    unseeded: [
      `tools.allowlist: "ggui.render_ui" names MCP server "ggui", which this agent does not connect — declare it under mcpServers or use one of: todo, ${RESERVED}`,
    ],
  },
  resolve: { seeded: { ggui: SEEDED_GGUI, todo: TODO }, unseeded: { todo: TODO } },
});

pinShape('5c. denylist ["ggui.*"], no declared servers', {
  schema: '1',
  agent: { ...BASE_AGENT, tools: GGUI_ALL_DENY },
}, {
  validate: {
    seeded: [],
    unseeded: [
      `tools.denylist: "ggui.*" names MCP server "ggui", which this agent does not connect — declare it under mcpServers or use one of: ${RESERVED}`,
    ],
  },
  resolve: { seeded: { ggui: SEEDED_GGUI }, unseeded: {} },
});

pinShape('5d. denylist ["ggui.render_ui"], todo declared', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { todo: TODO }, tools: GGUI_TOOL_DENY },
}, {
  validate: {
    seeded: [],
    unseeded: [
      `tools.denylist: "ggui.render_ui" names MCP server "ggui", which this agent does not connect — declare it under mcpServers or use one of: todo, ${RESERVED}`,
    ],
  },
  resolve: { seeded: { ggui: SEEDED_GGUI, todo: TODO }, unseeded: { todo: TODO } },
});

/**
 * The turn-time gate (`toolGatePredicate`) for the same blocks. It reads the
 * gates alone (no seed input): `undefined` means nothing is filtered on that
 * server, otherwise the predicate keeps a tool when it returns true.
 */
describe('5. toolGatePredicate on the ggui gate blocks', () => {
  it('allowlist ["ggui.*"]: ggui unfiltered; any other server keeps nothing', () => {
    expect(toolGatePredicate(GGUI_ALL_ALLOW, 'ggui')).toBeUndefined();
    const todo = toolGatePredicate(GGUI_ALL_ALLOW, 'todo');
    expect(todo?.('create_task')).toBe(false);
  });

  it('allowlist ["ggui.render_ui", "todo.create_task"]: each server keeps only its named tool', () => {
    const ggui = toolGatePredicate(GGUI_TOOL_ALLOW, 'ggui');
    expect(ggui?.('render_ui')).toBe(true);
    expect(ggui?.('list_components')).toBe(false);
    const todo = toolGatePredicate(GGUI_TOOL_ALLOW, 'todo');
    expect(todo?.('create_task')).toBe(true);
    expect(todo?.('render_ui')).toBe(false);
  });

  it('denylist ["ggui.*"]: ggui keeps nothing; any other server unfiltered', () => {
    const ggui = toolGatePredicate(GGUI_ALL_DENY, 'ggui');
    expect(ggui?.('render_ui')).toBe(false);
    expect(ggui?.('list_components')).toBe(false);
    expect(toolGatePredicate(GGUI_ALL_DENY, 'todo')).toBeUndefined();
  });

  it('denylist ["ggui.render_ui"]: ggui loses only that tool; any other server unfiltered', () => {
    const ggui = toolGatePredicate(GGUI_TOOL_DENY, 'ggui');
    expect(ggui?.('render_ui')).toBe(false);
    expect(ggui?.('list_components')).toBe(true);
    expect(toolGatePredicate(GGUI_TOOL_DENY, 'todo')).toBeUndefined();
  });
});

// ── 6. The new scaffold ─────────────────────────────────────────────────────

/** The co-located server the code-mode scaffold declares. */
const SCAFFOLD_TODO: GuueyAgentMcpServer = { kind: 'colocated', source: './mcps/todo', devPort: 6782 };

pinShape('6. new scaffold: ggui: false plus a declared server, no ggui section, no ggui tool gate', {
  schema: '1',
  agent: {
    mode: 'code',
    framework: 'claude-agent-sdk',
    model: 'claude-sonnet-5',
    systemPrompt: { file: 'prompts/system.md' },
    mcpServers: { ggui: false, todo: SCAFFOLD_TODO },
  },
}, {
  validate: { seeded: [], unseeded: [] },
  resolve: { seeded: { todo: SCAFFOLD_TODO }, unseeded: { todo: SCAFFOLD_TODO } },
});

pinShape('6b. new scaffold with a gate on its own server (allowlist ["todo.*"])', {
  schema: '1',
  agent: { ...BASE_AGENT, mcpServers: { ggui: false, todo: TODO }, tools: { allowlist: ['todo.*'] } },
}, {
  validate: { seeded: [], unseeded: [] },
  resolve: { seeded: { todo: TODO }, unseeded: { todo: TODO } },
});
