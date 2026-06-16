import { describe, expect, it } from 'vitest';
import { validateNoLiteralSecrets, type GuueyAgent } from './agent.js';

/** Build a minimal agent with one mcpServer whose headers we control. */
function withHeaders(headers: Record<string, string>): GuueyAgent {
  return {
    mcpServers: { api: { url: 'https://mcp.example.com', headers } },
  };
}

describe('validateNoLiteralSecrets — clean (no violations)', () => {
  it('pure ${env.NAME} ref on a sensitive header', () => {
    expect(validateNoLiteralSecrets(withHeaders({ Authorization: '${env.TOKEN}' }))).toEqual([]);
  });

  it('canonical ref-based Bearer (scheme word + ref) — the common legit pattern', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ Authorization: 'Bearer ${env.TOKEN}' })),
    ).toEqual([]);
  });

  it('ref-based X-API-Key', () => {
    expect(validateNoLiteralSecrets(withHeaders({ 'X-API-Key': '${env.KEY}' }))).toEqual([]);
  });

  it('non-secret literal headers (Content-Type, Accept, User-Agent)', () => {
    expect(
      validateNoLiteralSecrets(
        withHeaders({
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'User-Agent': 'my-agent/1.0',
        }),
      ),
    ).toEqual([]);
  });

  it('a ref embedded mid-literal on a non-sensitive header', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Tenant': 'prefix-${env.TENANT}-suffix' })),
    ).toEqual([]);
  });

  it('degenerate scheme-only value (no token, no ref)', () => {
    expect(validateNoLiteralSecrets(withHeaders({ Authorization: 'Bearer' }))).toEqual([]);
  });

  it('no mcpServers / no headers / undefined agent', () => {
    expect(validateNoLiteralSecrets(undefined)).toEqual([]);
    expect(validateNoLiteralSecrets({})).toEqual([]);
    expect(validateNoLiteralSecrets({ mcpServers: { x: { url: 'https://x' } } })).toEqual([]);
    expect(
      validateNoLiteralSecrets({ mcpServers: { x: { command: 'node', args: ['s.js'] } } }),
    ).toEqual([]);
  });
});

describe('validateNoLiteralSecrets — secret-shaped literals (layer 1, any header)', () => {
  it('Anthropic key baked into a Bearer on Authorization', () => {
    const v = validateNoLiteralSecrets(
      withHeaders({ Authorization: 'Bearer sk-ant-api03-deadbeefdeadbeef' }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/Authorization: contains a literal secret/);
  });

  it('catches secret-shaped literals on a NON-sensitive header too', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Custom': 'ghp_0123456789abcdefghijklmnopqrstuvwx' })),
    ).toHaveLength(1);
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Aws': 'AKIAIOSFODNN7EXAMPLE' })),
    ).toHaveLength(1);
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Slack': 'xoxb-1234567890-abcdefghij' })),
    ).toHaveLength(1);
  });

  it('OpenAI-style sk- key', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-API-Key': 'sk-0123456789abcdefghijABCD' })),
    ).toHaveLength(1);
  });
});

describe('validateNoLiteralSecrets — sensitive header, fully-literal value (layer 2)', () => {
  it('opaque (non-secret-shaped) API key with no ref → violation', () => {
    const v = validateNoLiteralSecrets(withHeaders({ 'X-API-Key': 'abc123def456ghi789' }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/sensitive header must reference a secret/);
  });

  it('Basic auth base64 (no ref) → violation', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ Authorization: 'Basic dXNlcjpwYXNzd29yZA==' })),
    ).toHaveLength(1);
  });

  it('a non-secret-shaped value on a NON-sensitive header is allowed', () => {
    // X-Tenant is not a credential header; an opaque literal is fine there.
    expect(validateNoLiteralSecrets(withHeaders({ 'X-Tenant': 'acme-prod' }))).toEqual([]);
  });
});

describe('validateNoLiteralSecrets — aggregation', () => {
  it('reports every violating header across servers, naming server + header', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        a: { url: 'https://a', headers: { Authorization: 'Bearer sk-ant-xxxxxxxxxxxxxxxx' } },
        b: { url: 'https://b', headers: { 'X-API-Key': 'rawkey123456', Accept: 'application/json' } },
      },
    };
    const v = validateNoLiteralSecrets(agent);
    expect(v).toHaveLength(2);
    expect(v.some((m) => m.startsWith('mcpServers.a.headers.Authorization'))).toBe(true);
    expect(v.some((m) => m.startsWith('mcpServers.b.headers.X-API-Key'))).toBe(true);
  });
});
