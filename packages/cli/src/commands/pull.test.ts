// private/guuey-cli/src/commands/pull.test.ts
//
// Tests for the pure `mapHostedStateToOverlay` function — the core
// of `guuey pull`. The mapper is pulled out of the command handler
// so we can exercise every shape combination without stubbing
// fetch / auth / filesystem. An integration-style `saveProjectConfig
// (mapper(...))` round-trip pins that the mapped output is
// schema-valid (otherwise the writer's zod gate throws).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GuueyJsonV1 } from '@guuey/config';
import {
  mapHostedStateToOverlay,
  type AppResponse,
  type DeploymentRow,
} from './pull';
import { saveProjectConfig, setConfigFile } from '../config';

// ─── Fixtures ────────────────────────────────────────────────────

const APP_PERSONAL: AppResponse = {
  id: 'app_12345',
  name: 'Weather Bot',
  workspaceId: null, // personal scope
  agentSize: null,
  primaryServingRegion: null,
};

const APP_WORKSPACE: AppResponse = {
  id: 'app_12345',
  name: 'Weather Bot',
  workspaceId: 'ws_01K',
  agentSize: 'sm',
  primaryServingRegion: 'us-east-1',
};

const DEPLOY_ROW_LIVE: DeploymentRow = {
  buildNumber: 3,
  status: 'live',
  endpointUrl: 'https://weather-bot.agents.guuey.com',
  deploymentId: 'build_01K9FY7XYZ',
  deployedAt: '2026-04-18T10:00:00.000Z',
};

const DEPLOY_ROW_QUEUED: DeploymentRow = {
  buildNumber: 4,
  status: 'queued',
  // No endpointUrl / deploymentId yet — not a real deployment record.
  endpointUrl: null,
  deploymentId: null,
  deployedAt: null,
};

// ─── mapHostedStateToOverlay — shape mapping ─────────────────────

describe('mapHostedStateToOverlay — project block', () => {
  it('maps app.id → project.id (always present)', () => {
    const overlay = mapHostedStateToOverlay(APP_PERSONAL, [], null);
    expect(overlay.project?.id).toBe('app_12345');
  });

  it('omits project.workspaceId for personal-scope apps', () => {
    const overlay = mapHostedStateToOverlay(APP_PERSONAL, [], null);
    expect(overlay.project?.workspaceId).toBeUndefined();
  });

  it('maps app.workspaceId → project.workspaceId when set', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.project?.workspaceId).toBe('ws_01K');
  });
});

describe('mapHostedStateToOverlay — deploy block', () => {
  it('omits the deploy block when every hosted deploy field is null', () => {
    const overlay = mapHostedStateToOverlay(APP_PERSONAL, [], null);
    expect(overlay.deploy).toBeUndefined();
  });

  it('maps app.agentSize → deploy.size', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.deploy?.size).toBe('sm');
  });

  it('maps app.primaryServingRegion → deploy.region', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.deploy?.region).toBe('us-east-1');
  });

  it('leaves deploy.runtime absent (no hosted data source today)', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.deploy?.runtime).toBeUndefined();
  });

  it('emits deploy block when only region is set, no size', () => {
    const overlay = mapHostedStateToOverlay(
      { ...APP_PERSONAL, primaryServingRegion: 'ap-northeast-2' },
      [],
      null,
    );
    expect(overlay.deploy).toEqual({ region: 'ap-northeast-2' });
  });
});

describe('mapHostedStateToOverlay — deployments[]', () => {
  it('writes an empty deployments[] when no rows are returned', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.deployments).toEqual([]);
  });

  it('maps a live deployment row onto the canonical shape', () => {
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [DEPLOY_ROW_LIVE],
      null,
    );
    expect(overlay.deployments).toEqual([
      {
        target: 'guuey',
        url: 'https://weather-bot.agents.guuey.com',
        buildId: 'build_01K9FY7XYZ',
        deployedAt: '2026-04-18T10:00:00.000Z',
      },
    ]);
  });

  it('filters out queued/failed rows (no endpointUrl OR no deploymentId)', () => {
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [DEPLOY_ROW_QUEUED, DEPLOY_ROW_LIVE],
      null,
    );
    expect(overlay.deployments).toHaveLength(1);
    expect(overlay.deployments?.[0]?.buildId).toBe('build_01K9FY7XYZ');
  });

  it('omits deployedAt per row when absent on the API response', () => {
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [{ ...DEPLOY_ROW_LIVE, deployedAt: null }],
      null,
    );
    expect(overlay.deployments?.[0]).not.toHaveProperty('deployedAt');
  });
});

// ─── mapHostedStateToOverlay — merge semantics ──────────────────

describe('mapHostedStateToOverlay — merge with existing local file', () => {
  it('preserves `mcpProxies` from the existing overlay', () => {
    const existing: GuueyJsonV1 = {
      schema: '1',
      deployments: [],
      mcpProxies: {
        claude_ai: {
          discovery: 'https://api.anthropic.com/v1/mcp_servers',
          proxy: 'https://mcp-proxy.anthropic.com/v1/mcp/{server_id}',
        },
      },
    };
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], existing);
    expect(overlay.mcpProxies).toEqual(existing.mcpProxies);
  });

  it('preserves `mcpServers` from the existing overlay', () => {
    const existing: GuueyJsonV1 = {
      schema: '1',
      deployments: [],
      mcpServers: {
        gmail: {
          url: 'https://mcp-proxy.guuey.com/proxy/gmail',
          auth: { serviceId: 'google_workspace' },
        },
      },
    };
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], existing);
    expect(overlay.mcpServers).toEqual(existing.mcpServers);
  });

  it('replaces `project` / `deploy` / `deployments` (hosted-truth fields)', () => {
    const stale: GuueyJsonV1 = {
      schema: '1',
      project: { id: 'stale_id' },
      deploy: { size: 'xl', region: 'stale-region' },
      deployments: [
        { target: 'guuey', url: 'https://stale.example.com' },
      ],
    };
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [DEPLOY_ROW_LIVE],
      stale,
    );
    expect(overlay.project?.id).toBe('app_12345');
    expect(overlay.deploy?.size).toBe('sm');
    expect(overlay.deploy?.region).toBe('us-east-1');
    expect(overlay.deployments).toHaveLength(1);
    expect(overlay.deployments?.[0]?.url).toBe(
      'https://weather-bot.agents.guuey.com',
    );
  });

  it('leaves `mcpProxies` absent when neither existing nor hosted supplies it', () => {
    const overlay = mapHostedStateToOverlay(APP_WORKSPACE, [], null);
    expect(overlay.mcpProxies).toBeUndefined();
    expect(overlay.mcpServers).toBeUndefined();
  });
});

// ─── schema round-trip — saveProjectConfig accepts the output ───

describe('mapHostedStateToOverlay — output round-trips through the canonical writer', () => {
  let originalCwd: string;
  let scratchDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    scratchDir = mkdtempSync(join(tmpdir(), 'guuey-pull-test-'));
    process.chdir(scratchDir);
    setConfigFile(join(scratchDir, '.guuey-global.json'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('writes a personal-scope pull result through saveProjectConfig', () => {
    const overlay = mapHostedStateToOverlay(APP_PERSONAL, [], null);
    // `saveProjectConfig` validates with `parseGuueyJson` — it
    // throws on malformed input. If this call succeeds, the mapper's
    // output is schema-valid.
    expect(() => saveProjectConfig(overlay)).not.toThrow();

    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk.schema).toBe('1');
    expect(onDisk.project).toEqual({ id: 'app_12345' });
    expect(onDisk.deployments).toEqual([]);
    expect(onDisk).not.toHaveProperty('deploy');
  });

  it('writes a full workspace-scope pull with live deployment', () => {
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [DEPLOY_ROW_LIVE],
      null,
    );
    expect(() => saveProjectConfig(overlay)).not.toThrow();

    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk).toEqual({
      schema: '1',
      project: { id: 'app_12345', workspaceId: 'ws_01K' },
      deploy: { size: 'sm', region: 'us-east-1' },
      deployments: [
        {
          target: 'guuey',
          url: 'https://weather-bot.agents.guuey.com',
          buildId: 'build_01K9FY7XYZ',
          deployedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
    });
  });

  it('writes a merged pull that preserves mcpProxies', () => {
    const existing: GuueyJsonV1 = {
      schema: '1',
      deployments: [],
      mcpProxies: {
        claude_ai: {
          discovery: 'https://api.anthropic.com/v1/mcp_servers',
          proxy: 'https://mcp-proxy.anthropic.com/v1/mcp/{server_id}',
        },
      },
    };
    const overlay = mapHostedStateToOverlay(
      APP_WORKSPACE,
      [DEPLOY_ROW_LIVE],
      existing,
    );
    expect(() => saveProjectConfig(overlay)).not.toThrow();

    const onDisk = JSON.parse(
      readFileSync(join(scratchDir, 'guuey.json'), 'utf-8'),
    );
    expect(onDisk.mcpProxies?.claude_ai?.discovery).toBe(
      'https://api.anthropic.com/v1/mcp_servers',
    );
    expect(onDisk.deployments).toHaveLength(1);
  });
});
