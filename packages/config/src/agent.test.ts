import { describe, expect, it } from 'vitest';
import { AgentSectionV1, validateNoLiteralSecrets, type GuueyAgent } from './agent.js';

/** Build a minimal agent with one mcpServer whose headers we control. */
function withHeaders(headers: Record<string, string>): GuueyAgent {
  return {
    mcpServers: { api: { kind: 'external', url: 'https://mcp.example.com', headers } },
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
    expect(
      validateNoLiteralSecrets({ mcpServers: { x: { kind: 'external', url: 'https://x' } } }),
    ).toEqual([]);
    expect(
      validateNoLiteralSecrets({ mcpServers: { x: { kind: 'colocated', command: 'node', args: ['s.js'] } } }),
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

describe('validateNoLiteralSecrets — extended patterns + name signals (review fixes)', () => {
  it('catches Stripe + JWT shapes on any header', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Stripe': 'sk_live_0123456789abcdefghij' })),
    ).toHaveLength(1);
    expect(
      validateNoLiteralSecrets(
        withHeaders({ 'X-Jwt': 'eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM' }),
      ),
    ).toHaveLength(1);
  });

  it('name-signal headers (X-Auth-*, *-secret, *-password) need a ref, not a literal', () => {
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Service-Auth': 'opaquekey123456' })),
    ).toHaveLength(1);
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Custom-Secret': 'opaqueval789' })),
    ).toHaveLength(1);
    // ...and a ref satisfies them.
    expect(
      validateNoLiteralSecrets(withHeaders({ 'X-Service-Auth': '${env.SVC_AUTH}' })),
    ).toEqual([]);
  });

  it('does NOT false-positive on benign key/token/version headers', () => {
    expect(validateNoLiteralSecrets(withHeaders({ 'Idempotency-Key': 'req-abc-123' }))).toEqual([]);
    expect(validateNoLiteralSecrets(withHeaders({ 'X-Request-Token': 'trace-456' }))).toEqual([]);
    expect(validateNoLiteralSecrets(withHeaders({ 'X-Api-Version': '2024-01-01' }))).toEqual([]);
  });
});

describe('validateNoLiteralSecrets — aggregation', () => {
  it('reports every violating header across servers, naming server + header', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        a: { kind: 'external', url: 'https://a', headers: { Authorization: 'Bearer sk-ant-xxxxxxxxxxxxxxxx' } },
        b: { kind: 'external', url: 'https://b', headers: { 'X-API-Key': 'rawkey123456', Accept: 'application/json' } },
      },
    };
    const v = validateNoLiteralSecrets(agent);
    expect(v).toHaveLength(2);
    expect(v.some((m) => m.startsWith('mcpServers.a.headers.Authorization'))).toBe(true);
    expect(v.some((m) => m.startsWith('mcpServers.b.headers.X-API-Key'))).toBe(true);
  });
});

// ── modelProvider schema tests ───────────────────────────────────────────────

describe("AgentSectionV1.modelProvider (P2 OpenRouter selection)", () => {
  it("accepts 'openrouter'", () => {
    const r = AgentSectionV1.safeParse({ framework: "openai-agents-sdk", modelProvider: "openrouter" });
    expect(r.success).toBe(true);
  });
  it("accepts 'openai'", () => {
    const r = AgentSectionV1.safeParse({ framework: "openai-agents-sdk", modelProvider: "openai" });
    expect(r.success).toBe(true);
  });
  it("is optional (absent is valid)", () => {
    const r = AgentSectionV1.safeParse({ framework: "openai-agents-sdk" });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown provider value", () => {
    const r = AgentSectionV1.safeParse({ modelProvider: "bedrock" });
    expect(r.success).toBe(false);
  });
});

// ── Discriminated union schema tests ─────────────────────────────────────────

describe('McpServerSchema — each kind parses correctly', () => {
  function parseMcpServers(mcpServers: unknown) {
    return AgentSectionV1.parse({ mcpServers });
  }

  it('colocated: command required, args/headers optional', () => {
    const r = parseMcpServers({
      tool: { kind: 'colocated', command: 'node', args: ['dist/tool.js'] },
    });
    expect(r.mcpServers?.tool).toEqual({ kind: 'colocated', command: 'node', args: ['dist/tool.js'] });
  });

  it('colocated: no command → parse error', () => {
    expect(() =>
      parseMcpServers({ tool: { kind: 'colocated' } }),
    ).toThrow();
  });

  it('hosted: server id variant', () => {
    const r = parseMcpServers({ todo: { kind: 'hosted', server: 'todo-abc123' } });
    expect(r.mcpServers?.todo).toEqual({ kind: 'hosted', server: 'todo-abc123' });
  });

  it('hosted: source path variant', () => {
    const r = parseMcpServers({ notes: { kind: 'hosted', source: './servers/notes' } });
    expect(r.mcpServers?.notes).toEqual({ kind: 'hosted', source: './servers/notes' });
  });

  it('hosted: BOTH server + source → allowed (deploy write-back keeps source, adds resolved server)', () => {
    const r = parseMcpServers({ h: { kind: 'hosted', server: 'abc', source: './path' } });
    expect(r.mcpServers?.h).toEqual({ kind: 'hosted', server: 'abc', source: './path' });
  });

  it('hosted: NEITHER server nor source → parse error', () => {
    expect(() =>
      parseMcpServers({ h: { kind: 'hosted' } }),
    ).toThrow(/needs `server`and\/or`source`/);
  });

  it('hosted entry accepts devPort and server+source together', () => {
    const parsed = AgentSectionV1.parse({
      mcpServers: {
        todo: { kind: 'hosted', source: './mcps/todo', server: 'mcp-todo-abc12345', devPort: 6782 },
      },
    });
    const todo = parsed.mcpServers?.todo;
    expect(todo).toMatchObject({
      kind: 'hosted',
      server: 'mcp-todo-abc12345',
      source: './mcps/todo',
      devPort: 6782,
    });
  });

  it('hosted entry still rejects neither server nor source', () => {
    expect(() => AgentSectionV1.parse({ mcpServers: { t: { kind: 'hosted' } } })).toThrow();
  });

  it('external entry accepts devPort; rejects out-of-range', () => {
    expect(() =>
      AgentSectionV1.parse({ mcpServers: { g: { kind: 'external', url: 'http://x', devPort: 0 } } }),
    ).toThrow();
    const ok = AgentSectionV1.parse({
      mcpServers: { g: { kind: 'external', url: 'http://x', devPort: 6781 } },
    });
    expect(ok.mcpServers?.g).toMatchObject({ devPort: 6781 });
  });

  it('proxied: connection required', () => {
    const r = parseMcpServers({ gmail: { kind: 'proxied', connection: 'gmail' } });
    expect(r.mcpServers?.gmail).toEqual({ kind: 'proxied', connection: 'gmail' });
  });

  it('external: url required', () => {
    const r = parseMcpServers({ acme: { kind: 'external', url: 'https://mcp.acme.com/' } });
    expect(r.mcpServers?.acme).toEqual({ kind: 'external', url: 'https://mcp.acme.com/' });
  });

  it('external: transport + federate + headers optional', () => {
    const r = parseMcpServers({
      acme: {
        kind: 'external',
        url: 'https://mcp.acme.com/',
        transport: 'sse',
        federate: true,
        headers: { 'X-Tenant': 'acme' },
      },
    });
    expect(r.mcpServers?.acme).toEqual({
      kind: 'external',
      url: 'https://mcp.acme.com/',
      transport: 'sse',
      federate: true,
      headers: { 'X-Tenant': 'acme' },
    });
  });

  it('old inferred shape (no kind, transport + url) now FAILS to parse', () => {
    // Pre-union: { transport: 'http', url: '...' } was valid.
    // Post-union: 'kind' discriminant is required.
    expect(() =>
      parseMcpServers({ old: { transport: 'http', url: 'https://mcp.example.com' } }),
    ).toThrow();
  });

  it('old stdio shape (no kind) now FAILS to parse', () => {
    expect(() =>
      parseMcpServers({ old: { transport: 'stdio', command: 'node' } }),
    ).toThrow();
  });
});
