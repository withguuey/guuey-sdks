/**
 * guuey#3361: the `seedGgui` input on the seed and the tool-gate server names.
 *
 * - Absent (and `{}`, and `{ seedGgui: true }`) is today's behavior, result for
 *   result, on every shape a stored definition can carry. That is the N−1
 *   proof: a caller that does not state the option yet sees no change.
 * - `{ seedGgui: false }` seeds nothing: the declared map, `ggui: false`
 *   dropped, every declared server kept (a declared render URL included).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_MCP_SERVERS,
  effectiveMcpServers,
  toolGateServerNames,
  validateSubmittedToolGates,
  validateToolGates,
  RESERVED_MCP_SERVER_NAMES,
  type GuueyAgent,
} from './agent.js';

const todo = { kind: 'external', url: 'https://todo.example.com/mcp', transport: 'http' } as const;
const mine = { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http', headers: { 'x-custom': 'v' } } as const;
const legacy = { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http' } as const;
const control = { kind: 'external', url: 'https://mcp.ggui.ai/control', credential: 'caller' } as const;
const perApp = { kind: 'external', url: 'https://mcp.ggui.ai/apps/App1', transport: 'http' } as const;

/** Every declared-map shape a stored definition carries today, by name. */
const SHAPES = {
  absent: undefined,
  empty: {},
  'declared only': { todo },
  'ggui: false': { ggui: false, todo },
  'ggui declared': { ggui: mine },
  'render URL under another key': { 'mcp-ggui-protocol': legacy },
  'same-host sibling': { control },
  'per-app address': { ui: perApp },
} as const;

describe('effectiveMcpServers({ seedGgui }) (guuey#3361)', () => {
  for (const [name, declared] of Object.entries(SHAPES)) {
    it(`${name}: absent, {} and { seedGgui: true } give one result`, () => {
      const today = effectiveMcpServers(declared);
      expect(effectiveMcpServers(declared, {})).toEqual(today);
      expect(effectiveMcpServers(declared, { seedGgui: true })).toEqual(today);
    });
  }

  it('seedGgui: true seeds the default exactly as before', () => {
    expect(effectiveMcpServers(undefined, { seedGgui: true })).toEqual(DEFAULT_AGENT_MCP_SERVERS);
    expect(effectiveMcpServers({ todo }, { seedGgui: true })).toEqual({ ggui: DEFAULT_AGENT_MCP_SERVERS.ggui, todo });
  });

  it('seedGgui: false seeds nothing and keeps every declared server', () => {
    const unseeded = { seedGgui: false } as const;
    expect(effectiveMcpServers(undefined, unseeded)).toEqual({});
    expect(effectiveMcpServers({}, unseeded)).toEqual({});
    expect(effectiveMcpServers({ todo }, unseeded)).toEqual({ todo });
    expect(effectiveMcpServers({ ggui: false, todo }, unseeded)).toEqual({ todo });
    expect(effectiveMcpServers({ ggui: mine }, unseeded)).toEqual({ ggui: mine });
    expect(effectiveMcpServers({ 'mcp-ggui-protocol': legacy }, unseeded)).toEqual({ 'mcp-ggui-protocol': legacy });
    expect(effectiveMcpServers({ control }, unseeded)).toEqual({ control });
    expect(effectiveMcpServers({ ui: perApp }, unseeded)).toEqual({ ui: perApp });
  });
});

describe('the tool-gate server names follow the same input (guuey#3361)', () => {
  const gated = (allowlist: string[], mcpServers?: GuueyAgent['mcpServers']): GuueyAgent => ({
    mcpServers,
    tools: { allowlist },
  });

  it('toolGateServerNames: absent and { seedGgui: true } name ggui; false does not', () => {
    const agent = { mcpServers: { todo } };
    expect(toolGateServerNames(agent)).toEqual(['ggui', 'todo', ...RESERVED_MCP_SERVER_NAMES]);
    expect(toolGateServerNames(agent, { seedGgui: true })).toEqual(toolGateServerNames(agent));
    expect(toolGateServerNames(agent, { seedGgui: false })).toEqual(['todo', ...RESERVED_MCP_SERVER_NAMES]);
  });

  it('validateToolGates and validateSubmittedToolGates read today\'s names when the option is absent', () => {
    const agent = gated(['ggui.*', 'todo.create_task'], { todo });
    expect(validateToolGates(agent)).toEqual([]);
    expect(validateToolGates(agent, { seedGgui: true })).toEqual([]);
    expect(validateSubmittedToolGates(agent)).toEqual([]);
    expect(validateSubmittedToolGates(agent, { seedGgui: true })).toEqual([]);
  });

  it('under seedGgui: false a ggui entry names a server the agent does not connect (until #3362 accepts it as retired)', () => {
    const agent = gated(['ggui.*', 'todo.create_task'], { todo });
    const [violation, ...rest] = validateToolGates(agent, { seedGgui: false });
    expect(rest).toEqual([]);
    expect(violation).toContain('"ggui.*" names MCP server "ggui"');
  });

  it('validateSubmittedToolGates takes the input into a mode\'s lists, where it checks server names', () => {
    const agent: GuueyAgent = {
      mcpServers: { todo },
      modes: { focus: { tools: { allowlist: ['ggui.*'] } } },
    };
    expect(validateSubmittedToolGates(agent)).toEqual(validateSubmittedToolGates(agent, { seedGgui: true }));
    expect(validateSubmittedToolGates(agent, { seedGgui: false }).join('\n')).toContain('"ggui.*" names MCP server "ggui"');
  });
});
