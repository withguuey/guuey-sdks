import { describe, expect, it } from 'vitest';
import { planMcpLegs, writeBackServerId, snapshotWithServerIds } from './deploy-plan.js';
import type { GuueyAgent, GuueyJsonV1 } from '@guuey/config';

// ─── planMcpLegs ─────────────────────────────────────────────────────────

describe('planMcpLegs', () => {
  it('lists hosted+source entries, flagging already-resolved ones', () => {
    const agent = {
      mcpServers: {
        todo: { kind: 'hosted', source: './mcps/todo', devPort: 6782 },
        prev: { kind: 'hosted', source: './mcps/prev', server: 'mcp-prev-1' },
        ext: { kind: 'external', url: 'https://x' },
      },
    } as GuueyAgent;

    expect(planMcpLegs(agent)).toEqual([
      { name: 'todo', source: './mcps/todo', hasServerId: false },
      { name: 'prev', source: './mcps/prev', hasServerId: true },
    ]);
  });

  it('skips hosted entries with no source (server-only refs)', () => {
    const agent = {
      mcpServers: {
        remote: { kind: 'hosted', server: 'mcp-abc' },
      },
    } as GuueyAgent;

    expect(planMcpLegs(agent)).toEqual([]);
  });

  it('skips colocated + proxied entries', () => {
    const agent = {
      mcpServers: {
        local: { kind: 'colocated', command: 'node', args: ['s.js'] },
        conn: { kind: 'proxied', connection: 'conn-1' },
      },
    } as GuueyAgent;

    expect(planMcpLegs(agent)).toEqual([]);
  });

  it('returns an empty array when mcpServers is absent', () => {
    expect(planMcpLegs({} as GuueyAgent)).toEqual([]);
  });
});

// ─── writeBackServerId ───────────────────────────────────────────────────

describe('writeBackServerId', () => {
  const baseDoc: GuueyJsonV1 = {
    schema: '1',
    protocol: 'silver',
    agent: {
      framework: 'claude-agent-sdk',
      systemPrompt: 'hi',
      mcpServers: {
        todo: { kind: 'hosted', source: './mcps/todo', devPort: 6782 },
      },
    },
  };

  it('sets server and preserves source+devPort', () => {
    const next = writeBackServerId(baseDoc, 'todo', 'mcp-todo-1');
    expect(next.agent.mcpServers?.todo).toEqual({
      kind: 'hosted',
      source: './mcps/todo',
      devPort: 6782,
      server: 'mcp-todo-1',
    });
    // Deep-merge, not mutation — original untouched.
    expect(baseDoc.agent.mcpServers?.todo).toEqual({
      kind: 'hosted',
      source: './mcps/todo',
      devPort: 6782,
    });
  });

  it('overwrites an existing server id on re-deploy', () => {
    const withServer: GuueyJsonV1 = {
      ...baseDoc,
      agent: {
        ...baseDoc.agent,
        mcpServers: {
          todo: { kind: 'hosted', source: './mcps/todo', server: 'mcp-old' },
        },
      },
    };
    const next = writeBackServerId(withServer, 'todo', 'mcp-new');
    expect(next.agent.mcpServers?.todo).toEqual({
      kind: 'hosted',
      source: './mcps/todo',
      server: 'mcp-new',
    });
  });

  it('throws when the named entry is missing or not hosted', () => {
    expect(() => writeBackServerId(baseDoc, 'missing', 'mcp-x')).toThrow(/missing/);
    const withExternal: GuueyJsonV1 = {
      ...baseDoc,
      agent: {
        ...baseDoc.agent,
        mcpServers: { ext: { kind: 'external', url: 'https://x' } },
      },
    };
    expect(() => writeBackServerId(withExternal, 'ext', 'mcp-x')).toThrow(/hosted/);
  });
});

// ─── snapshotWithServerIds ────────────────────────────────────────────────

describe('snapshotWithServerIds', () => {
  it('passes through a doc where every hosted entry has a server id', () => {
    const doc: GuueyJsonV1 = {
      schema: '1',
      protocol: 'silver',
      agent: {
        framework: 'claude-agent-sdk',
        systemPrompt: 'hi',
        mcpServers: {
          todo: { kind: 'hosted', source: './mcps/todo', server: 'mcp-todo-1' },
          ext: { kind: 'external', url: 'https://x' },
        },
      },
    };
    expect(snapshotWithServerIds(doc)).toBe(doc);
  });

  it('passes through a doc with no mcpServers at all', () => {
    const doc: GuueyJsonV1 = {
      schema: '1',
      protocol: 'silver',
      agent: { framework: 'claude-agent-sdk', systemPrompt: 'hi' },
    };
    expect(snapshotWithServerIds(doc)).toBe(doc);
  });

  it('throws when a hosted entry lacks server, naming the offender', () => {
    const doc: GuueyJsonV1 = {
      schema: '1',
      protocol: 'silver',
      agent: {
        framework: 'claude-agent-sdk',
        systemPrompt: 'hi',
        mcpServers: {
          todo: { kind: 'hosted', source: './mcps/todo' },
        },
      },
    };
    expect(() => snapshotWithServerIds(doc)).toThrow(/todo/);
  });

  it('names every offender when multiple hosted entries lack server', () => {
    const doc: GuueyJsonV1 = {
      schema: '1',
      protocol: 'silver',
      agent: {
        framework: 'claude-agent-sdk',
        systemPrompt: 'hi',
        mcpServers: {
          todo: { kind: 'hosted', source: './mcps/todo' },
          other: { kind: 'hosted', source: './mcps/other' },
        },
      },
    };
    expect(() => snapshotWithServerIds(doc)).toThrow(/todo.*other|other.*todo/);
  });
});
