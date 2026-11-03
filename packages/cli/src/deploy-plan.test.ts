import { describe, expect, it } from 'vitest';
import {
  planMcpLegs,
  writeBackServerId,
  snapshotWithServerIds,
  resolveDeployMode,
  shouldOfferAppCreate,
  noAppLinkedRemedy,
  declarativeRedirect,
  liveAgentMode,
  nocodeLiveRefusal,
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
  it('guuey.json + package.json + NO mode + no Dockerfile → declarative, refused (package.json presence is ignored)', () => {
    expect(
      resolveDeployMode(signals({ hasGuueyJson: true, hasPackageJson: true })),
    ).toEqual({ kind: 'declarative' });
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

  it("agent.mode='declarative' + Dockerfile → declarative, refused (explicit declaration wins)", () => {
    expect(
      resolveDeployMode(
        signals({ hasGuueyJson: true, hasDockerfile: true, agentMode: 'declarative' }),
      ),
    ).toEqual({ kind: 'declarative' });
  });

  it("agent.mode='declarative' wins over --code: an app goes code through guuey eject, never a flag", () => {
    expect(
      resolveDeployMode(
        signals({ forceCode: true, hasGuueyJson: true, hasPackageJson: true, agentMode: 'declarative' }),
      ),
    ).toEqual({ kind: 'declarative' });
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

  it.each([
    ['alone', signals({ forceDeclarative: true })],
    ['with a guuey.json declaring code', signals({ forceDeclarative: true, hasGuueyJson: true, agentMode: 'code' })],
    ['with --code', signals({ forceDeclarative: true, forceCode: true })],
  ])('--declarative %s → declarative, refused (the flag says the project is no-code)', (_label, s) => {
    expect(resolveDeployMode(s)).toEqual({ kind: 'declarative' });
  });

  it('no guuey.json, no Dockerfile, no flags → error naming both doors', () => {
    const r = resolveDeployMode(signals({}));
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.message).toContain('guuey create');
      expect(r.message).toContain('guuey agent apply');
    }
  });
});

// ─── declarativeRedirect ─────────────────────────────────────────────────

describe('declarativeRedirect', () => {
  it('a bare deploy: the apply line with --wait, and eject as the door to code', () => {
    const text = declarativeRedirect({});
    expect(text).toContain('guuey deploy deploys code-mode apps');
    expect(text).toContain('  guuey agent apply --wait\n');
    expect(text).not.toContain('guuey agent config');
    expect(text).not.toContain('Pod size');
    expect(text).not.toContain('--label');
    expect(text.endsWith('To switch this app to code mode for good, run: guuey eject')).toBe(true);
  });

  it('--app-id and --env-file carry onto the apply line, and the app id onto eject', () => {
    const text = declarativeRedirect({ appId: 'app-9', envFile: '.env.prod' });
    expect(text).toContain('  guuey agent apply --wait --app-id app-9 --env-file .env.prod');
    expect(text).toContain('run: guuey eject --app-id app-9');
  });

  it('--max-pods and --runtime-auto-update move to ONE agent config line', () => {
    const text = declarativeRedirect({ appId: 'app-9', maxPods: '3', runtimeAutoUpdate: 'off' });
    expect(text).toContain('  guuey agent config --app-id app-9 --max-pods 3 --runtime-auto-update off');
  });

  it('--size points at guuey.json agent.deploy.size (the door sizes a no-code build from it)', () => {
    expect(declarativeRedirect({ size: 'md' })).toContain('set "deploy": { "size": "md" } under "agent", then apply');
  });

  it('--label says no-code builds record provenance instead', () => {
    expect(declarativeRedirect({ label: 'v1' })).toContain('guuey agent apply --provenance <org/repo>@<sha>');
  });
});

// ─── liveAgentMode / nocodeLiveRefusal ───────────────────────────────────

describe('liveAgentMode', () => {
  it('the newest LIVE row wins, whatever the list order', () => {
    expect(
      liveAgentMode([
        { buildNumber: 3, status: 'live', agentMode: 'nocode' },
        { buildNumber: 5, status: 'live', agentMode: 'code' },
        { buildNumber: 4, status: 'superseded', agentMode: 'nocode' },
      ]),
    ).toBe('code');
  });

  it('a live no-code build behind newer in-flight or failed rows is still the serving one', () => {
    expect(
      liveAgentMode([
        { buildNumber: 7, status: 'building', agentMode: 'code' },
        { buildNumber: 6, status: 'failed', agentMode: 'code' },
        { buildNumber: 2, status: 'live', agentMode: 'nocode' },
      ]),
    ).toBe('nocode');
  });

  it('null when nothing is live (a first deploy, or a torn-down app)', () => {
    expect(liveAgentMode([])).toBeNull();
    expect(liveAgentMode([{ buildNumber: 1, status: 'undeployed', agentMode: 'nocode' }])).toBeNull();
  });
});

describe('nocodeLiveRefusal', () => {
  it('names the app, why deploy stops, and both doors', () => {
    const text = nocodeLiveRefusal('app-1');
    expect(text).toContain('App app-1 is live on');
    expect(text).toContain('for good');
    expect(text).toContain('guuey eject --app-id app-1');
    expect(text).toContain('guuey agent apply');
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

  it('false for the legacy-Dockerfile mode even on a TTY', () => {
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

  it('skips colocated + credential:oauth external entries (nothing of the builder\'s to build)', () => {
    const agent = {
      mcpServers: {
        local: { kind: 'colocated', source: './mcps/local' },
        linear: { kind: 'external', url: 'https://mcp.linear.app/mcp', credential: 'oauth' },
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

// ─── noAppLinkedRemedy (guuey#1064) ───────────────────────────────────────────
describe('noAppLinkedRemedy', () => {
  it('code-orchestrated: the interactive sentence is true — auto-create offers there', () => {
    const r = noAppLinkedRemedy('code-orchestrated');
    expect(r).toContain('run "guuey deploy" in an interactive terminal to create one');
    expect(r).toContain('guuey pull --app-id <id>');
  });

  it.each(['code-legacy-dockerfile'] as const)('%s: never promises an interactive create (auto-create never offers) — names apps create instead', (mode) => {
    const r = noAppLinkedRemedy(mode);
    expect(r).not.toContain('interactive terminal');
    expect(r).toContain('guuey apps create --name <name>');
    expect(r).toContain('guuey pull --app-id <id>');
  });
});
