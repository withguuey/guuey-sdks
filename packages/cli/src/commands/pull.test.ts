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
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  mapHostedStateToOverlay,
  pickSnapshotBuild,
  pull,
  resolveDraftPromptAction,
  SYSTEM_PROMPT_FILE,
  type AppResponse,
  type DeploymentRow,
} from './pull.js';
import { loadProjectConfig, saveProjectConfig } from '../config.js';
import {
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  GUUEY_SCAFFOLD_SYSTEM_PROMPT,
} from '@guuey/config';

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

// ─── resolveDraftPromptAction (pure — the guuey#463 replace rule) ─────

describe('resolveDraftPromptAction', () => {
  const DRAFT = 'You are the console-drafted agent.';

  it('writes when the local prompts/system.md is missing', () => {
    expect(resolveDraftPromptAction(DRAFT, null)).toEqual({
      kind: 'write',
      content: DRAFT,
    });
  });

  it('writes over a local file byte-identical to the SCAFFOLD default, as stamped (text + "\\n")', () => {
    expect(
      resolveDraftPromptAction(DRAFT, `${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`),
    ).toEqual({ kind: 'write', content: DRAFT });
  });

  it('writes over the RUNTIME default too — both shipped texts are known defaults', () => {
    expect(
      resolveDraftPromptAction(DRAFT, `${GUUEY_DEFAULT_SYSTEM_PROMPT}\n`),
    ).toEqual({ kind: 'write', content: DRAFT });
  });

  it('still recognizes a default whose editor stripped the final newline', () => {
    expect(
      resolveDraftPromptAction(DRAFT, GUUEY_SCAFFOLD_SYSTEM_PROMPT),
    ).toEqual({ kind: 'write', content: DRAFT });
  });

  it('never clobbers a diverged local prompt — one changed byte is builder-authored text', () => {
    expect(
      resolveDraftPromptAction(DRAFT, `${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\nMy edit.\n`),
    ).toEqual({ kind: 'diverged' });
    expect(resolveDraftPromptAction(DRAFT, 'My own prompt.\n')).toEqual({
      kind: 'diverged',
    });
  });

  it('no-ops when the wire has no draft: absent field (older cliApi), null, or empty', () => {
    // `undefined` is the degrade-gracefully case — an older cliApi that
    // omits the field entirely must not turn pull into a clobber.
    expect(resolveDraftPromptAction(undefined, null)).toEqual({ kind: 'none' });
    expect(resolveDraftPromptAction(null, null)).toEqual({ kind: 'none' });
    expect(resolveDraftPromptAction('', null)).toEqual({ kind: 'none' });
    // Even when the local file is a replaceable known default.
    expect(
      resolveDraftPromptAction(undefined, `${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`),
    ).toEqual({ kind: 'none' });
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
    vi.mocked(existsSync).mockReset();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReset();
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

  // ─── The create-time draft (guuey#463, the #455 rider) ─────────────

  const DRAFT = 'You are the console-drafted agent.';

  /** Stub the two-request no-snapshot exchange (app row + empty deployments). */
  function stubNoSnapshotExchange(app: AppResponse): void {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ app }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deployments: [] }), { status: 200 }),
      );
  }

  it('seeds prompts/system.md from the draft when the local file is the untouched scaffold default', async () => {
    stubNoSnapshotExchange({ id: 'app-1', displayName: 'Todo', draftSystemPrompt: DRAFT });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`);

    await pull({});

    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, body] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(String(path)).toMatch(/prompts\/system\.md$/);
    expect(body).toBe(DRAFT);
    // The overlay write still happens (identity refresh), agent untouched.
    expect(saveProjectConfig).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(saveProjectConfig).mock.calls[0]![0] as GuueyJsonV1).agent,
    ).toEqual(localScaffold().agent);
  });

  it('seeds prompts/system.md from the draft when the local file is missing entirely', async () => {
    stubNoSnapshotExchange({ id: 'app-1', draftSystemPrompt: DRAFT });
    vi.mocked(existsSync).mockReturnValue(false);

    await pull({});

    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileSync).mock.calls[0]![1]).toBe(DRAFT);
  });

  it('leaves a diverged local prompt untouched and prints the notice', async () => {
    stubNoSnapshotExchange({ id: 'app-1', draftSystemPrompt: DRAFT });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('My hand-edited prompt.\n');

    await pull({});

    expect(writeFileSync).not.toHaveBeenCalled();
    const logged = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(' '))
      .join('\n');
    expect(logged).toMatch(/left untouched/);
  });

  it('a live nocode snapshot takes precedence over the draft — the deployed prompt wins', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            app: { id: 'app-1', displayName: 'Todo', draftSystemPrompt: DRAFT },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            deployments: [
              { buildNumber: 3, status: 'live', agentMode: 'nocode', size: 'sm' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ snapshot: nocodeSnapshot() }), { status: 200 }),
      );
    // Even a replaceable local default must NOT be re-written from the draft.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`);

    await pull({});

    // Exactly one prompt write: the snapshot's externalize — never the draft.
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeFileSync).mock.calls[0]![1]).toBe(
      'You are the deployed studio agent.',
    );
  });

  it('degrades to a no-op against an older cliApi that omits draftSystemPrompt', async () => {
    stubNoSnapshotExchange({ id: 'app-1', displayName: 'Todo' });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`);

    await pull({});

    expect(writeFileSync).not.toHaveBeenCalled();
    expect(saveProjectConfig).toHaveBeenCalledTimes(1);
  });
});
