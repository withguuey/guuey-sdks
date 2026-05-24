import { describe, expect, it } from 'vitest';
import {
  GUUEY_JSON_FILENAME,
  GuueyJsonV1,
  parseGuueyJson,
  safeParseGuueyJson,
  type GuueyJsonDeploy,
  type GuueyJsonDeployment,
  type GuueyJsonProject,
} from './schema.js';

/**
 * Minimal v1 overlay document — all required fields, nothing optional.
 * The overlay carries `schema` + (defaulted) `deployments`; it does
 * NOT carry portable agent identity / blueprints / policy — those
 * fields live in `ggui.json` (`@ggui-ai/project-config`). `project`
 * and `deploy` are optional additive blocks populated once the
 * project links to Guuey hosting.
 */
const MINIMAL_V1 = {
  schema: '1' as const,
};

describe('guuey.json schema — filename constant', () => {
  it('is exactly "guuey.json"', () => {
    expect(GUUEY_JSON_FILENAME).toBe('guuey.json');
  });
});

describe('guuey.json schema — minimum viable document', () => {
  it('accepts a minimal valid v1 doc and fills the deployments default', () => {
    const parsed = parseGuueyJson(MINIMAL_V1);
    expect(parsed.schema).toBe('1');
    expect(parsed.deployments).toEqual([]);
    expect(parsed.project).toBeUndefined();
    expect(parsed.deploy).toBeUndefined();
  });

  it('round-trips cleanly through JSON.stringify + re-parse', () => {
    const once = parseGuueyJson(MINIMAL_V1);
    const twice = parseGuueyJson(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('keeps `deployments` when provided', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      deployments: [
        {
          target: 'guuey' as const,
          url: 'https://weather-bot.agents.guuey.com',
          deployedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
    });
    expect(parsed.deployments).toHaveLength(1);
    expect(parsed.deployments[0].target).toBe('guuey');
  });
});

describe('guuey.json schema — project identity block', () => {
  it('accepts the optional `project` block when both ids are present', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      project: {
        id: 'proj_01K9FY7ABCD',
        workspaceId: 'ws_01K9FY7EFGH',
      },
    });
    const project: GuueyJsonProject | undefined = parsed.project;
    expect(project?.id).toBe('proj_01K9FY7ABCD');
    expect(project?.workspaceId).toBe('ws_01K9FY7EFGH');
  });

  it('rejects a `project` block missing `id`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      project: { workspaceId: 'ws_x' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a `project` block with only `id` (personal-scope / pre-pull)', () => {
    // 2026-04-21 — `workspaceId` widened to optional so `guuey create`
    // / `guuey link` can stamp `{project: {id}}` immediately off the
    // `POST /apps` response (which doesn't return a workspaceId), and
    // personal-scope apps can legitimately carry no workspaceId.
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      project: { id: 'proj_x' },
    });
    expect(parsed.project?.id).toBe('proj_x');
    expect(parsed.project?.workspaceId).toBeUndefined();
  });

  it('rejects empty-string identifiers inside `project`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      project: { id: '', workspaceId: 'ws_x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string `workspaceId` when present', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      project: { id: 'proj_x', workspaceId: '' },
    });
    expect(result.success).toBe(false);
  });
});

describe('guuey.json schema — deploy shape block', () => {
  it('accepts the optional `deploy` block with every field set', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      deploy: {
        size: 'sm' as const,
        runtime: 'node22',
        region: 'us-east-1',
      },
    });
    const deploy: GuueyJsonDeploy | undefined = parsed.deploy;
    expect(deploy).toEqual({ size: 'sm', runtime: 'node22', region: 'us-east-1' });
  });

  it('accepts an empty `deploy` block', () => {
    const parsed = parseGuueyJson({ ...MINIMAL_V1, deploy: {} });
    expect(parsed.deploy).toEqual({});
  });

  it('rejects an unknown `deploy.size` value', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      deploy: { size: 'huge' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts every canonical agent size on `deploy.size`', () => {
    for (const size of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
      const parsed = parseGuueyJson({
        ...MINIMAL_V1,
        deploy: { size },
      });
      expect(parsed.deploy?.size).toBe(size);
    }
  });

  it('rejects empty strings on free-form fields', () => {
    const runtime = safeParseGuueyJson({
      ...MINIMAL_V1,
      deploy: { runtime: '' },
    });
    const region = safeParseGuueyJson({
      ...MINIMAL_V1,
      deploy: { region: '' },
    });
    expect(runtime.success).toBe(false);
    expect(region.success).toBe(false);
  });
});

describe('guuey.json schema — deployment record', () => {
  it('accepts a record with the optional `buildId` set', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      deployments: [
        {
          target: 'guuey' as const,
          url: 'https://weather-bot.agents.guuey.com',
          deployedAt: '2026-04-18T10:00:00.000Z',
          buildId: 'build_01K9FY7XYZ',
        },
      ],
    });
    const entry: GuueyJsonDeployment = parsed.deployments[0];
    expect(entry.buildId).toBe('build_01K9FY7XYZ');
  });

  it('rejects an empty `buildId`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      deployments: [
        {
          target: 'guuey',
          url: 'https://example.agents.guuey.com',
          buildId: '',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL `deployment.url`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      deployments: [{ target: 'local', url: 'not a url' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO `deployedAt`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      deployments: [
        {
          target: 'local',
          url: 'http://localhost:4000',
          deployedAt: 'yesterday',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown `deployment.target`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      deployments: [{ target: 'fly', url: 'https://example.fly.dev' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('guuey.json schema — overlay-only boundary', () => {
  // These tests guard the prune: portable fields from `ggui.json`
  // (agent identity, blueprints, policy) must not be re-introduced
  // to this schema. Zod's default behaviour strips unknown keys on
  // parse, so these documents parse successfully but the portable
  // fields do not survive. A future edit that re-adds one of these
  // fields to the schema has to also update these tests.
  it('strips a portable `agent` field (belongs in ggui.json)', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      agent: {
        slug: 'weather-bot',
        name: 'Weather Bot',
        mode: 'personal',
        llm: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        mcp: { tools: [] },
      },
    }) as GuueyJsonV1 & { agent?: unknown };
    expect(parsed.agent).toBeUndefined();
  });

  it('strips a portable `blueprints` field (belongs in ggui.json)', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      blueprints: [{ id: 'dashboard', source: './blueprints/dashboard.tsx' }],
    }) as GuueyJsonV1 & { blueprints?: unknown };
    expect(parsed.blueprints).toBeUndefined();
  });

  it('strips a portable `policy` field (belongs in ggui.json)', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      policy: { residency: 'local', sandboxing: 'process' },
    }) as GuueyJsonV1 & { policy?: unknown };
    expect(parsed.policy).toBeUndefined();
  });

  it('strips legacy CLI fields that predate the overlay shape', () => {
    // The closed `guuey` CLI historically wrote a flat set of local-dev
    // fields into `guuey.json` (`appId`, `host`, `bridgeUrl`, …). Those
    // do NOT belong in the overlay per §8.4 — they're either hosted
    // identity (now carried by `project.id`) or local-dev URLs that
    // should live in env. The schema strips them on parse; a future
    // CLI migration physically removes them from written files. This
    // test guards the strip so we never silently re-accept them.
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      appId: 'app_legacy',
      host: 'https://platform.guuey.com',
      bridgeUrl: 'wss://ws.guuey.com/v1',
      quality: 'fast',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    }) as GuueyJsonV1 & {
      appId?: unknown;
      host?: unknown;
      bridgeUrl?: unknown;
      quality?: unknown;
      model?: unknown;
    };
    expect(parsed.appId).toBeUndefined();
    expect(parsed.host).toBeUndefined();
    expect(parsed.bridgeUrl).toBeUndefined();
    expect(parsed.quality).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });
});

describe('guuey.json schema — mcpProxies block', () => {
  // Added 2026-04-21 once the mcp-proxy classification split landed
  // and the overlay-type module moved into this package.
  it('accepts the optional `mcpProxies` block with a claude_ai entry', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      mcpProxies: {
        claude_ai: {
          discovery: 'https://api.anthropic.com/v1/mcp_servers',
          proxy: 'https://mcp-proxy.anthropic.com/v1/mcp/{server_id}',
          linking: {
            authUrl: 'https://claude.com/cai/oauth/authorize',
            tokenUrl: 'https://platform.claude.com/v1/oauth/token',
            scopes: ['user:mcp_servers'],
          },
          servers: ['Gmail'],
        },
      },
    });
    expect(parsed.mcpProxies?.claude_ai?.servers).toEqual(['Gmail']);
    expect(parsed.mcpProxies?.claude_ai?.linking?.scopes).toEqual([
      'user:mcp_servers',
    ]);
  });

  it('accepts an empty `mcpProxies` record', () => {
    const parsed = parseGuueyJson({ ...MINIMAL_V1, mcpProxies: {} });
    expect(parsed.mcpProxies).toEqual({});
  });

  it('leaves `mcpProxies` undefined on a minimal document', () => {
    const parsed = parseGuueyJson(MINIMAL_V1);
    expect(parsed.mcpProxies).toBeUndefined();
  });

  it('rejects a `mcpProxies` entry missing `discovery`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      mcpProxies: {
        claude_ai: { proxy: 'https://proxy.example.com/{id}' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on a `mcpProxies` entry (strict)', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      mcpProxies: {
        claude_ai: {
          discovery: 'https://discovery.example.com/mcp',
          proxy: 'https://proxy.example.com/{id}',
          bogus: 'rejected',
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('guuey.json schema — mcpServers block', () => {
  // Added 2026-04-21 once the mcpServers classification split landed
  // (McpServerAuthConfig relocated out of @ggui-ai/protocol).
  it('accepts the optional `mcpServers` block with a gmail entry', () => {
    const parsed = parseGuueyJson({
      ...MINIMAL_V1,
      mcpServers: {
        gmail: {
          url: 'https://mcp-proxy.guuey.com/proxy/gmail',
          auth: {
            serviceId: 'google_workspace',
            preInject: true,
            injection: { mode: 'bearer_header' },
          },
        },
      },
    });
    expect(parsed.mcpServers?.gmail?.url).toBe(
      'https://mcp-proxy.guuey.com/proxy/gmail',
    );
    expect(parsed.mcpServers?.gmail?.auth?.serviceId).toBe('google_workspace');
    expect(parsed.mcpServers?.gmail?.auth?.injection?.mode).toBe(
      'bearer_header',
    );
  });

  it('accepts an empty `mcpServers` record', () => {
    const parsed = parseGuueyJson({ ...MINIMAL_V1, mcpServers: {} });
    expect(parsed.mcpServers).toEqual({});
  });

  it('leaves `mcpServers` undefined on a minimal document', () => {
    const parsed = parseGuueyJson(MINIMAL_V1);
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('rejects a `mcpServers` entry with a non-URL `url`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      mcpServers: { x: { url: 'not-a-url' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a `mcpServers` auth block with empty `serviceId`', () => {
    const result = safeParseGuueyJson({
      ...MINIMAL_V1,
      mcpServers: {
        x: {
          url: 'https://mcp.example.com',
          auth: { serviceId: '' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('guuey.json schema — schema pin literal', () => {
  it('rejects documents missing the schema pin', () => {
    const result = safeParseGuueyJson({});
    expect(result.success).toBe(false);
  });

  it('rejects documents on a future schema pin', () => {
    const result = safeParseGuueyJson({ ...MINIMAL_V1, schema: '2' });
    expect(result.success).toBe(false);
  });

  it('rejects the legacy `version: "1"` pin (renamed in 2026-04-20 expansion)', () => {
    const result = safeParseGuueyJson({ version: '1' });
    expect(result.success).toBe(false);
  });
});

describe('guuey.json schema — typed export sanity', () => {
  it('`GuueyJsonV1` (the value) is the Zod schema', () => {
    // `GuueyJsonV1` is both a runtime Zod schema and a compile-time
    // type (merged via `export type`). Exercise the runtime side.
    const again = GuueyJsonV1.parse(MINIMAL_V1);
    expect(again.schema).toBe('1');
  });
});
