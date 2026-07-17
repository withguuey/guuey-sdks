/**
 * `guuey pull` — the real eject: pull the agent definition from the
 * latest no-code deployment snapshot (J5).
 *
 * Two pure TDD seams carry the logic and are tested without any I/O:
 *   - `pickSnapshotBuild` — the deployment-pick rule (newest LIVE nocode).
 *   - `mapHostedStateToOverlay` — replace agent on nocode snapshot /
 *     preserve on code-or-none; externalize the inlined systemPrompt.
 *
 * `pull()` is covered end-to-end with the `apps.test.ts` convention:
 * `vi.mock('../auth.js'|'../config.js')` for auth/base-URL + persistence,
 * `vi.spyOn(globalThis,'fetch')` for the wire, and a `node:fs` mock to
 * capture the `prompts/system.md` externalize write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { GuueyJsonV1 } from '@guuey/config';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn(() => ({
      pat: 'pat-test',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
  };
});

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    resolveConfig: vi.fn(() => ({
      host: 'https://guuey.test',
      apiUrl: 'https://api.guuey.test',
      appId: 'app-1',
    })),
    loadProjectConfig: vi.fn(),
    saveProjectConfig: vi.fn(),
    getProjectConfigPath: vi.fn(() => '/proj/guuey.json'),
  };
});

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  mapHostedStateToOverlay,
  pickSnapshotBuild,
  pull,
  SYSTEM_PROMPT_FILE,
  type AppResponse,
  type DeploymentRow,
} from './pull.js';
import { loadProjectConfig, saveProjectConfig } from '../config.js';

/** A scaffold-shaped local overlay (the fresh `guuey create` output). */
function localScaffold(): GuueyJsonV1 {
  return {
    schema: '1',
    appId: 'app-old',
    workspaceId: 'ws-1',
    worker: 'guuey.worker.js',
    agent: {
      mode: 'code',
      framework: 'claude-agent-sdk',
      model: 'claude-sonnet-5',
      systemPrompt: { file: 'prompts/system.md' },
      mcpServers: {
        todo: { kind: 'hosted', source: './mcps/todo', devPort: 6782 },
      },
    },
    protocol: 'silver',
  };
}

/**
 * A deployed no-code definition snapshot (systemPrompt inlined string).
 * Studio stamps `mode: 'declarative'` into every snapshot it deploys
 * (`apps/studio/src/lib/agents/agent-config.ts`) — this fixture must carry
 * it too, or the mode-preservation regression it's meant to catch can't
 * repro.
 */
function nocodeSnapshot(): GuueyJsonV1 {
  return {
    schema: '1',
    appId: 'app-1',
    agent: {
      mode: 'declarative',
      framework: 'claude-agent-sdk',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are the deployed studio agent.',
      mcpServers: {
        ggui: { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http' },
      },
      deploy: { size: 'sm', region: 'us-east-1' },
    },
    protocol: 'silver',
  };
}

const APP: AppResponse = { id: 'app-1', displayName: 'Todo' };

// ─── pickSnapshotBuild (pure) ────────────────────────────────────────

describe('pickSnapshotBuild', () => {
  it('picks the live nocode build, ignoring code + non-live rows', () => {
    const rows: DeploymentRow[] = [
      { buildNumber: 5, status: 'live', agentMode: 'code' },
      { buildNumber: 4, status: 'superseded', agentMode: 'nocode' },
      { buildNumber: 3, status: 'live', agentMode: 'nocode' },
    ];
    expect(pickSnapshotBuild(rows)).toBe(3);
  });

  it('picks the newest (highest buildNumber) live nocode row regardless of order', () => {
    const rows: DeploymentRow[] = [
      { buildNumber: 2, status: 'live', agentMode: 'nocode' },
      { buildNumber: 7, status: 'live', agentMode: 'nocode' },
      { buildNumber: 5, status: 'live', agentMode: 'nocode' },
    ];
    expect(pickSnapshotBuild(rows)).toBe(7);
  });

  it('returns null when there is no live nocode row (code-mode / in-flight only)', () => {
    const rows: DeploymentRow[] = [
      { buildNumber: 9, status: 'building', agentMode: 'nocode' },
      { buildNumber: 8, status: 'live', agentMode: 'code' },
    ];
    expect(pickSnapshotBuild(rows)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickSnapshotBuild([])).toBeNull();
  });
});

// ─── mapHostedStateToOverlay (pure) ──────────────────────────────────

describe('mapHostedStateToOverlay', () => {
  it('replaces the local agent with the nocode snapshot + externalizes the systemPrompt', () => {
    const { overlay, promptFile, agentReplaced } = mapHostedStateToOverlay(
      APP,
      nocodeSnapshot(),
      localScaffold(),
    );

    expect(agentReplaced).toBe(true);
    // Identity refreshed from the app row.
    expect(overlay.appId).toBe('app-1');
    // Non-agent top-level fields preserved from the local overlay.
    expect(overlay.workspaceId).toBe('ws-1');
    expect(overlay.worker).toBe('guuey.worker.js');
    // Agent section fully REPLACED (not merged) EXCEPT deploy routing: the
    // scaffold's `mode: 'code'` survives even though the snapshot says
    // `mode: 'declarative'` (Studio's stamp) — pull replaces the agent
    // DEFINITION, never the local deploy ROUTING. The todo MCP is gone;
    // the snapshot's definition (framework/model/mcpServers) is present.
    expect(overlay.agent.mode).toBe('code');
    expect(overlay.agent.model).toBe('claude-opus-4-8');
    expect(overlay.agent.deploy).toEqual({ size: 'sm', region: 'us-east-1' });
    expect(Object.keys(overlay.agent.mcpServers ?? {})).toEqual(['ggui']);
    // systemPrompt externalized back to a file ref (round-trip editable).
    expect(overlay.agent.systemPrompt).toEqual({ file: SYSTEM_PROMPT_FILE });
    expect(promptFile).toEqual({
      path: SYSTEM_PROMPT_FILE,
      content: 'You are the deployed studio agent.',
    });
  });

  it('omits agent.mode entirely (not `undefined`, not the snapshot\'s `declarative`) when the local project has none', () => {
    const local = localScaffold();
    delete local.agent.mode;
    const { overlay } = mapHostedStateToOverlay(APP, nocodeSnapshot(), local);

    expect('mode' in overlay.agent).toBe(false);
    expect(overlay.agent.mode).toBeUndefined();
    // Definition fields still come from the snapshot.
    expect(overlay.agent.model).toBe('claude-opus-4-8');
  });

  it('honors a snapshot systemPrompt that is already a { file } ref (no externalize write)', () => {
    const snap = nocodeSnapshot();
    snap.agent.systemPrompt = { file: 'prompts/custom.md' };
    const { overlay, promptFile } = mapHostedStateToOverlay(
      APP,
      snap,
      localScaffold(),
    );
    expect(overlay.agent.systemPrompt).toEqual({ file: 'prompts/custom.md' });
    expect(promptFile).toBeNull();
  });

  it('preserves the local agent when there is no snapshot (code-mode / nothing deployed)', () => {
    const local = localScaffold();
    const { overlay, promptFile, agentReplaced } = mapHostedStateToOverlay(
      APP,
      null,
      local,
    );
    expect(agentReplaced).toBe(false);
    expect(promptFile).toBeNull();
    // Identity refreshed, agent left untouched.
    expect(overlay.appId).toBe('app-1');
    expect(overlay.agent).toEqual(local.agent);
  });

  it('reads only app.id for identity (wire-drift: no name/workspaceId phantom fields)', () => {
    // An app row with ONLY `id` (no displayName) still refreshes appId.
    const { overlay } = mapHostedStateToOverlay(
      { id: 'app-bare' },
      null,
      localScaffold(),
    );
    expect(overlay.appId).toBe('app-bare');
    // workspaceId comes from the LOCAL overlay, never the app row.
    expect(overlay.workspaceId).toBe('ws-1');
  });

  it('throws when there is no existing guuey.json', () => {
    expect(() =>
      mapHostedStateToOverlay(APP, nocodeSnapshot(), null),
    ).toThrow(/existing guuey\.json/);
  });
});

// ─── pull() end-to-end ───────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
}

function requestAt(
  fetchSpy: MockInstance<typeof fetch>,
  index: number,
): CapturedRequest {
  const call = fetchSpy.mock.calls[index];
  if (!call) throw new Error(`fetch call #${index} not made`);
  const [url, init] = call;
  return {
    method: String(init?.method),
    path: new URL(String(url)).pathname,
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe('pull()', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitSignal(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadProjectConfig).mockReturnValue(localScaffold());
    vi.mocked(saveProjectConfig).mockReset();
    vi.mocked(mkdirSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ejects the latest live nocode snapshot: fetches build #3, externalizes the prompt, replaces the agent', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'Todo' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployments: [
              { buildNumber: 2, status: 'superseded', agentMode: 'nocode', size: 'sm' },
              { buildNumber: 3, status: 'live', agentMode: 'nocode', size: 'sm' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot: nocodeSnapshot() }), { status: 200 }),
      );

    await pull({});

    // Three requests; the third targets the picked live nocode build.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(requestAt(fetchSpy, 0).path).toBe('/apps/app-1');
    expect(requestAt(fetchSpy, 1).path).toBe('/apps/app-1/deployments');
    expect(requestAt(fetchSpy, 2).path).toBe('/apps/app-1/deployments/3');

    // The inlined systemPrompt is externalized to prompts/system.md.
    expect(mkdirSync).toHaveBeenCalledTimes(1);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [promptPath, promptBody] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(promptPath)).toMatch(/prompts\/system\.md$/);
    expect(promptBody).toBe('You are the deployed studio agent.');

    // The written overlay has the replaced agent + externalized ref.
    expect(saveProjectConfig).toHaveBeenCalledTimes(1);
    const written = vi.mocked(saveProjectConfig).mock.calls[0]![0] as GuueyJsonV1;
    expect(written.appId).toBe('app-1');
    expect(written.agent.model).toBe('claude-opus-4-8');
    expect(written.agent.systemPrompt).toEqual({ file: SYSTEM_PROMPT_FILE });
  });

  it('degrades to identity-only when there is no live nocode deployment (code-mode)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ app: { id: 'app-1', displayName: 'Coder' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployments: [{ buildNumber: 4, status: 'live', agentMode: 'code', size: 'sm' }],
          }),
          { status: 200 },
        ),
      );

    await pull({});

    // No snapshot GET — only app + deployments.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(writeFileSync).not.toHaveBeenCalled();

    // Agent preserved; identity refreshed.
    expect(saveProjectConfig).toHaveBeenCalledTimes(1);
    const written = vi.mocked(saveProjectConfig).mock.calls[0]![0] as GuueyJsonV1;
    expect(written.appId).toBe('app-1');
    expect(written.agent).toEqual(localScaffold().agent);
  });
});
