import { describe, expect, it } from 'vitest';
import {
  planMcpLegs,
  writeBackServerId,
  snapshotWithServerIds,
  resolveDeployMode,
  shouldOfferAppCreate,
  type DeployModeSignals,
} from './deploy-plan.js';
import type { GuueyAgent, GuueyJsonV1 } from '@guuey/config';

// ─── resolveDeployMode ───────────────────────────────────────────────────

/** All-false baseline; each test names only the signals it turns on. */
function signals(overrides: Partial<DeployModeSignals>): DeployModeSignals {
  return {
    forceDeclarative: false,
    forceCode: false,
    hasGuueyJson: false,
    hasDockerfile: false,
    hasPackageJson: false,
    agentMode: undefined,
    ...overrides,
  };
}

describe('resolveDeployMode', () => {
  it('guuey.json + package.json + NO mode + no Dockerfile → declarative (package.json presence is ignored)', () => {
    expect(
      resolveDeployMode(signals({ hasGuueyJson: true, hasPackageJson: true })),
    ).toEqual({ kind: 'mode', mode: 'declarative' });
  });

  it("agent.mode='code' + Dockerfile → code-orchestrated (explicit declaration wins)", () => {
    expect(
      resolveDeployMode(
        signals({
          hasGuueyJson: true,
          hasPackageJson: true,
          hasDockerfile: true,
          agentMode: 'code',
        }),
      ),
    ).toEqual({ kind: 'mode', mode: 'code-orchestrated' });
  });

  it('Dockerfile-only (no guuey.json) → legacy code path', () => {
    expect(resolveDeployMode(signals({ hasDockerfile: true }))).toEqual({
      kind: 'mode',
      mode: 'code-legacy-dockerfile',
    });
  });

  it('Dockerfile + guuey.json without mode → legacy code path (pre-existing behavior)', () => {
    expect(
      resolveDeployMode(
        signals({ hasDockerfile: true, hasGuueyJson: true, hasPackageJson: true }),
      ),
    ).toEqual({ kind: 'mode', mode: 'code-legacy-dockerfile' });
  });

  it("agent.mode='code' without a Dockerfile → code-orchestrated", () => {
    expect(
      resolveDeployMode(
        signals({ hasGuueyJson: true, hasPackageJson: true, agentMode: 'code' }),
      ),
    ).toEqual({ kind: 'mode', mode: 'code-orchestrated' });
  });

  it("agent.mode='declarative' + Dockerfile → declarative (explicit declaration wins)", () => {
    expect(
      resolveDeployMode(
        signals({ hasGuueyJson: true, hasDockerfile: true, agentMode: 'declarative' }),
      ),
    ).toEqual({ kind: 'mode', mode: 'declarative' });
  });

  it('--code + guuey.json → code-orchestrated even with a Dockerfile', () => {
    expect(
      resolveDeployMode(
        signals({
          forceCode: true,
          hasGuueyJson: true,
          hasPackageJson: true,
          hasDockerfile: true,
        }),
      ),
    ).toEqual({ kind: 'mode', mode: 'code-orchestrated' });
  });

  it('--code + Dockerfile-only → legacy code path', () => {
    expect(resolveDeployMode(signals({ forceCode: true, hasDockerfile: true }))).toEqual({
      kind: 'mode',
      mode: 'code-legacy-dockerfile',
    });
  });

  it('--code with neither Dockerfile nor package.json → early actionable error naming both', () => {
    const r = resolveDeployMode(signals({ forceCode: true }));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toMatch(/package\.json/);
      expect(r.message).toMatch(/Dockerfile/);
    }
  });

  it('code mode with guuey.json but no package.json → error naming package.json, before any build attempt', () => {
    const r = resolveDeployMode(
      signals({ hasGuueyJson: true, agentMode: 'code' }),
    );
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/package\.json/);
  });

  it('--declarative without a guuey.json → error', () => {
    const r = resolveDeployMode(signals({ forceDeclarative: true }));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/--declarative/);
  });

  it('--declarative + guuey.json → declarative even when agent.mode=code', () => {
    expect(
      resolveDeployMode(
        signals({ forceDeclarative: true, hasGuueyJson: true, agentMode: 'code' }),
      ),
    ).toEqual({ kind: 'mode', mode: 'declarative' });
  });

  it('both --declarative and --code → error', () => {
    const r = resolveDeployMode(signals({ forceDeclarative: true, forceCode: true }));
    expect(r.kind).toBe('error');
  });

  it('no guuey.json, no Dockerfile, no flags → error', () => {
    const r = resolveDeployMode(signals({}));
    expect(r.kind).toBe('error');
  });
});

// ─── shouldOfferAppCreate ────────────────────────────────────────────────

describe('shouldOfferAppCreate', () => {
  it('true only for code-orchestrated with BOTH stdin and stdout TTYs', () => {
    expect(shouldOfferAppCreate('code-orchestrated', true, true)).toBe(true);
  });

  it('false when either side is not a TTY (fail-fast instead of a hanging prompt)', () => {
    expect(shouldOfferAppCreate('code-orchestrated', false, true)).toBe(false);
    expect(shouldOfferAppCreate('code-orchestrated', true, false)).toBe(false);
    expect(shouldOfferAppCreate('code-orchestrated', undefined, undefined)).toBe(false);
  });

  it('false for declarative and legacy-Dockerfile modes even on a TTY', () => {
    expect(shouldOfferAppCreate('declarative', true, true)).toBe(false);
    expect(shouldOfferAppCreate('code-legacy-dockerfile', true, true)).toBe(false);
  });
});

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
