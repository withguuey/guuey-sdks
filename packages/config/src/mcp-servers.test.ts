import { describe, expect, it } from 'vitest';
import {
  McpServersSchema,
  parseMcpServers,
  safeParseMcpServers,
  type CredentialInjection,
  type CredentialInjectionConfig,
  type McpServerAuthConfig,
  type McpServerEntryConfig,
  type McpServersConfig,
} from './mcp-servers.js';

/**
 * A realistic mcpServers entry — `url` + a full auth block with
 * injection override. Used as the positive fixture throughout.
 */
const GMAIL_ENTRY: McpServerEntryConfig = {
  url: 'https://mcp-proxy.guuey.com/proxy/gmail',
  auth: {
    serviceId: 'google_workspace',
    preInject: true,
    injection: {
      mode: 'bearer_header',
    },
  },
};

describe('mcp-servers overlay schema — empty + minimal', () => {
  it('accepts an empty record', () => {
    const parsed = parseMcpServers({});
    expect(parsed).toEqual({});
  });

  it('accepts a minimal entry (no auth block)', () => {
    const parsed = parseMcpServers({
      public_mcp: { url: 'https://mcp.example.com' },
    });
    expect(parsed.public_mcp?.url).toBe('https://mcp.example.com');
    expect(parsed.public_mcp?.auth).toBeUndefined();
  });

  it('accepts a full auth + injection entry', () => {
    const parsed = parseMcpServers({ gmail: GMAIL_ENTRY });
    const entry: McpServerEntryConfig | undefined = parsed.gmail;
    expect(entry?.url).toBe(GMAIL_ENTRY.url);
    const auth: McpServerAuthConfig | undefined = entry?.auth;
    expect(auth?.serviceId).toBe('google_workspace');
    expect(auth?.preInject).toBe(true);
    const injection: CredentialInjectionConfig | undefined = auth?.injection;
    expect(injection?.mode).toBe('bearer_header');
  });
});

describe('mcp-servers overlay schema — auth block', () => {
  it('accepts auth with only serviceId (no preInject, no injection)', () => {
    const parsed = parseMcpServers({
      slack: {
        url: 'https://mcp.example.com/slack',
        auth: { serviceId: 'slack_oauth' },
      },
    });
    expect(parsed.slack?.auth?.serviceId).toBe('slack_oauth');
    expect(parsed.slack?.auth?.preInject).toBeUndefined();
    expect(parsed.slack?.auth?.injection).toBeUndefined();
  });

  it('rejects auth with empty-string serviceId', () => {
    const result = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: { serviceId: '' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on the auth block (strict)', () => {
    const result = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: { serviceId: 'ok', bogus: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional `scopes` array on the auth block', () => {
    // 2026-04-21 — `scopes` kept alive for wire-compat with the
    // hosted `@guuey/bridge` flow which forwards this to the
    // platform at connect time.
    const parsed = parseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: { serviceId: 's', scopes: ['read:calendar', 'write:events'] },
      },
    });
    expect(parsed.x?.auth?.scopes).toEqual(['read:calendar', 'write:events']);
  });

  it('rejects empty-string entries in `auth.scopes`', () => {
    const result = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: { serviceId: 's', scopes: ['ok', ''] },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp-servers overlay schema — injection block', () => {
  it('accepts every canonical injection mode', () => {
    const MODES: CredentialInjection[] = [
      'bearer_header',
      'api_key_header',
      'query_param',
      'custom_header',
    ];
    for (const mode of MODES) {
      const parsed = parseMcpServers({
        x: {
          url: 'https://mcp.example.com',
          auth: { serviceId: 's', injection: { mode } },
        },
      });
      expect(parsed.x?.auth?.injection?.mode).toBe(mode);
    }
  });

  it('accepts optional headerName + paramName', () => {
    const parsed = parseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: {
          serviceId: 's',
          injection: {
            mode: 'custom_header',
            headerName: 'X-Custom-Token',
            paramName: 'token',
          },
        },
      },
    });
    expect(parsed.x?.auth?.injection?.headerName).toBe('X-Custom-Token');
    expect(parsed.x?.auth?.injection?.paramName).toBe('token');
  });

  it('rejects an unknown injection mode', () => {
    const result = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: { serviceId: 's', injection: { mode: 'magic' } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty-string `headerName` and `paramName`', () => {
    const headerResult = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: {
          serviceId: 's',
          injection: { mode: 'custom_header', headerName: '' },
        },
      },
    });
    const paramResult = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: {
          serviceId: 's',
          injection: { mode: 'query_param', paramName: '' },
        },
      },
    });
    expect(headerResult.success).toBe(false);
    expect(paramResult.success).toBe(false);
  });

  it('rejects unknown keys on the injection block (strict)', () => {
    const result = safeParseMcpServers({
      x: {
        url: 'https://mcp.example.com',
        auth: {
          serviceId: 's',
          injection: { mode: 'bearer_header', extra: 'no' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp-servers overlay schema — entry structure', () => {
  it('rejects an entry missing `url`', () => {
    const result = safeParseMcpServers({
      x: { auth: { serviceId: 'ok' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL `url`', () => {
    const result = safeParseMcpServers({
      x: { url: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys on an entry (strict)', () => {
    const result = safeParseMcpServers({
      x: { url: 'https://mcp.example.com', bogus: 42 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string key in the record', () => {
    const result = safeParseMcpServers({
      '': { url: 'https://mcp.example.com' },
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp-servers overlay schema — round trip', () => {
  it('round-trips a full document through JSON.stringify + re-parse', () => {
    const doc: McpServersConfig = {
      gmail: GMAIL_ENTRY,
      slack: { url: 'https://mcp.example.com/slack' },
    };
    const once = parseMcpServers(doc);
    const twice = parseMcpServers(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('exports the zod schema itself for composition', () => {
    // The raw schema mounts on `GuueyJsonV1` as an optional field.
    // Exercise the runtime side directly.
    const again = McpServersSchema.parse({ x: { url: 'https://mcp.example.com' } });
    expect(again.x?.url).toBe('https://mcp.example.com');
  });
});
