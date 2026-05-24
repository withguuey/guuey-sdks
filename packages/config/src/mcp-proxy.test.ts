import { describe, expect, it } from 'vitest';
import {
  McpProxiesSchema,
  parseMcpProxies,
  safeParseMcpProxies,
  type McpProxiesConfig,
  type McpProxyConfig,
  type McpProxyLinkingConfig,
} from './mcp-proxy.js';

/**
 * A realistic `claude_ai` proxy entry — used as the positive fixture
 * throughout. Mirrors the `CLAUDE_AI_OAUTH` constants in
 * `@ggui-ai/protocol/types/mcp-proxy.ts`.
 */
const CLAUDE_AI_ENTRY: McpProxyConfig = {
  discovery: 'https://api.anthropic.com/v1/mcp_servers',
  proxy: 'https://mcp-proxy.anthropic.com/v1/mcp/{server_id}',
  linking: {
    authUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    scopes: ['user:mcp_servers'],
    manualRedirectUrl: 'https://platform.claude.com/oauth/code/callback',
  },
  servers: ['Gmail', 'Google Calendar'],
};

describe('mcp-proxy overlay schema — empty + minimal', () => {
  it('accepts an empty record', () => {
    const parsed = parseMcpProxies({});
    expect(parsed).toEqual({});
  });

  it('accepts a minimal proxy entry (no linking, no servers filter)', () => {
    const parsed = parseMcpProxies({
      guuey: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{server_id}',
      },
    });
    expect(parsed.guuey).toBeDefined();
    expect(parsed.guuey?.linking).toBeUndefined();
    expect(parsed.guuey?.servers).toBeUndefined();
  });

  it('accepts a full claude_ai-shaped proxy entry', () => {
    const parsed = parseMcpProxies({ claude_ai: CLAUDE_AI_ENTRY });
    const entry: McpProxyConfig | undefined = parsed.claude_ai;
    expect(entry?.discovery).toBe(CLAUDE_AI_ENTRY.discovery);
    expect(entry?.proxy).toBe(CLAUDE_AI_ENTRY.proxy);
    expect(entry?.servers).toEqual(['Gmail', 'Google Calendar']);
    const linking: McpProxyLinkingConfig | undefined = entry?.linking;
    expect(linking?.scopes).toEqual(['user:mcp_servers']);
  });
});

describe('mcp-proxy overlay schema — linking block', () => {
  it('accepts empty scopes (upstream default scope set)', () => {
    const parsed = parseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
        },
      },
    });
    expect(parsed.custom?.linking?.scopes).toEqual([]);
  });

  it('accepts optional clientId + manualRedirectUrl', () => {
    const parsed = parseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: ['read'],
          clientId: 'client_abc',
          manualRedirectUrl: 'https://example.com/oauth/code',
        },
      },
    });
    expect(parsed.custom?.linking?.clientId).toBe('client_abc');
    expect(parsed.custom?.linking?.manualRedirectUrl).toBe(
      'https://example.com/oauth/code',
    );
  });

  it('rejects non-URL `authUrl`', () => {
    const result = safeParseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'not a url',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL `manualRedirectUrl`', () => {
    const result = safeParseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
          manualRedirectUrl: 'not-a-url',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string clientId', () => {
    const result = safeParseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
          clientId: '',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty scope strings inside the scopes array', () => {
    const result = safeParseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/mcp/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: ['ok', ''],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp-proxy overlay schema — proxy-entry structure', () => {
  it('rejects a proxy entry missing `discovery`', () => {
    const result = safeParseMcpProxies({
      claude_ai: { proxy: 'https://proxy.example.com/{id}' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a proxy entry missing `proxy`', () => {
    const result = safeParseMcpProxies({
      claude_ai: { discovery: 'https://discovery.example.com/mcp' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on a proxy entry (strict)', () => {
    const result = safeParseMcpProxies({
      claude_ai: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/{id}',
        bogus: 'rejected',
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on the linking block (strict)', () => {
    const result = safeParseMcpProxies({
      custom: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/{id}',
        linking: {
          authUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopes: [],
          bogus: true,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string server filter entries', () => {
    const result = safeParseMcpProxies({
      claude_ai: {
        discovery: 'https://discovery.example.com/mcp',
        proxy: 'https://proxy.example.com/{id}',
        servers: ['Gmail', ''],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp-proxy overlay schema — round trip', () => {
  it('round-trips a full document through JSON.stringify + re-parse', () => {
    const doc: McpProxiesConfig = { claude_ai: CLAUDE_AI_ENTRY };
    const once = parseMcpProxies(doc);
    const twice = parseMcpProxies(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('exports the zod schema itself for composition', () => {
    // The raw schema is used by `GuueyJsonV1` in `schema.ts` to mount
    // `mcpProxies` as an optional overlay field. Exercise the runtime side.
    const again = McpProxiesSchema.parse({ guuey: CLAUDE_AI_ENTRY });
    expect(again.guuey?.discovery).toBe(CLAUDE_AI_ENTRY.discovery);
  });
});
