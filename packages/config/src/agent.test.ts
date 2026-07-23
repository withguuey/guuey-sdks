import { describe, expect, it } from 'vitest';
import {
  AgentSectionV1,
  validateColocatedServerNames,
  validateNoLiteralSecrets,
  validateNoProxiedServers,
  validateReservedServerNames,
  RESERVED_MEMORY_SERVER_NAME,
  RESERVED_MCP_SERVER_NAMES,
  type GuueyAgent,
  type GuueyAgentMcpServer,
} from './agent.js';

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
      validateNoLiteralSecrets({ mcpServers: { x: { kind: 'colocated', source: './mcps/x' } } }),
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

// ── validateColocatedServerNames (deploy-time colocated-name check) ─────────
//
// `agent.mcpServers`'s key is schema-typed only `z.string().min(1)` — bad
// names (spaces, slashes, ...) parse fine but throw at pod boot inside
// `lowerColocated` -> `colocatedResourceUrl`. This is the client-side
// pre-flight `@guuey/cli`'s `commands/deploy.ts` runs before upload.

describe('validateColocatedServerNames', () => {
  it('no mcpServers / undefined agent -> clean', () => {
    expect(validateColocatedServerNames(undefined)).toEqual([]);
    expect(validateColocatedServerNames({})).toEqual([]);
  });

  it('a valid colocated name passes', () => {
    const agent: GuueyAgent = {
      mcpServers: { notes_v1: { kind: 'colocated', source: './mcps/notes' } },
    };
    expect(validateColocatedServerNames(agent)).toEqual([]);
  });

  it('non-colocated entries are never checked, even with "invalid" names', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        'not a name': { kind: 'external', url: 'https://mcp.example.com' },
      },
    };
    expect(validateColocatedServerNames(agent)).toEqual([]);
  });

  it('a colocated name with a space is rejected with the actionable message', () => {
    const agent: GuueyAgent = {
      mcpServers: { 'my tool': { kind: 'colocated', source: './mcps/tool' } },
    };
    expect(validateColocatedServerNames(agent)).toEqual([
      'colocated MCP server name "my tool" is invalid — use only letters, digits, hyphen, underscore (it becomes part of a URL and a storage scope)',
    ]);
  });

  it('a colocated name with a slash is rejected', () => {
    const agent: GuueyAgent = {
      mcpServers: { 'a/b': { kind: 'colocated', source: './mcps/tool' } },
    };
    expect(validateColocatedServerNames(agent)).toHaveLength(1);
  });

  it('reports every violating colocated entry across servers', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        'bad one': { kind: 'colocated', source: './mcps/a' },
        good: { kind: 'colocated', source: './mcps/b' },
        'bad two': { kind: 'colocated', source: './mcps/c' },
      },
    };
    const v = validateColocatedServerNames(agent);
    expect(v).toHaveLength(2);
    expect(v.some((m) => m.includes('"bad one"'))).toBe(true);
    expect(v.some((m) => m.includes('"bad two"'))).toBe(true);
  });
});

// ── validateNoProxiedServers (deploy-time proxied-kind rejection) ───────────
//
// `kind: 'proxied'` keeps its schema arm (the documented mcp-proxy broker
// deferral) but is unsupported at runtime — an agent that deploys one boots
// silently missing those tools. This deploy-time pre-flight (mirrors
// `validateColocatedServerNames`'s shape) rejects it loudly; the
// deploy-controller's `resolveMcpServersInSnapshot` throw is the authoritative
// backstop for code deploys.

describe('validateNoProxiedServers', () => {
  it('no mcpServers / undefined agent -> clean', () => {
    expect(validateNoProxiedServers(undefined)).toEqual([]);
    expect(validateNoProxiedServers({})).toEqual([]);
  });

  it('a proxied entry is reported with an actionable message', () => {
    const agent: GuueyAgent = {
      mcpServers: { saas: { kind: 'proxied', connection: 'conn-1' } },
    };
    const v = validateNoProxiedServers(agent);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"saas"');
    expect(v[0]).toContain('proxied');
    expect(v[0]).toContain('not yet supported');
  });

  it('non-proxied entries (colocated / external / hosted) pass clean', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        local: { kind: 'colocated', source: './mcps/local' },
        ext: { kind: 'external', url: 'https://mcp.example.com' },
        reg: { kind: 'hosted', server: 'srv-1' },
      },
    };
    expect(validateNoProxiedServers(agent)).toEqual([]);
  });

  it('reports every proxied entry across servers', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        a: { kind: 'proxied', connection: 'c1' },
        good: { kind: 'external', url: 'https://mcp.example.com' },
        b: { kind: 'proxied', connection: 'c2' },
      },
    };
    const v = validateNoProxiedServers(agent);
    expect(v).toHaveLength(2);
    expect(v.some((m) => m.includes('"a"'))).toBe(true);
    expect(v.some((m) => m.includes('"b"'))).toBe(true);
  });
});

// ── validateReservedServerNames (deploy-time reserved-key rejection) ────────
//
// `guuey-memory` is a platform-RESERVED `mcpServers` key: the runtime splices
// the auto-injected memory MCP under it (memmcp). A builder-declared server of
// that name would boot as builder code under the same key AND be replaced by
// the platform entry at invoke time. This deploy-time pre-flight (mirrors
// `validateNoProxiedServers`'s shape) rejects it loudly; the run-seam collision
// guard is the defense-in-depth backstop for stale pre-validator snapshots.

describe('validateReservedServerNames', () => {
  it('no mcpServers / undefined agent -> clean', () => {
    expect(validateReservedServerNames(undefined)).toEqual([]);
    expect(validateReservedServerNames({})).toEqual([]);
  });

  it('rejects a builder-declared colocated "guuey-memory" with an actionable message', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        [RESERVED_MEMORY_SERVER_NAME]: { kind: 'colocated', source: './mcps/mem' },
      },
    };
    const v = validateReservedServerNames(agent);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"guuey-memory"');
    expect(v[0]).toContain('reserved');
  });

  it('rejects the reserved name REGARDLESS of kind (external shadow attempt)', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        [RESERVED_MEMORY_SERVER_NAME]: {
          kind: 'external',
          url: 'https://evil.example.com',
        },
      },
    };
    expect(validateReservedServerNames(agent)).toHaveLength(1);
  });

  it('non-reserved names (any kind) pass clean', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        memory_v1: { kind: 'colocated', source: './mcps/mem' },
        ext: { kind: 'external', url: 'https://mcp.example.com' },
        ggui: { kind: 'external', url: 'https://mcp.ggui.ai' },
      },
    };
    expect(validateReservedServerNames(agent)).toEqual([]);
  });

  it('reports every reserved entry present (alongside clean servers)', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        [RESERVED_MEMORY_SERVER_NAME]: { kind: 'colocated', source: './a' },
        fine: { kind: 'external', url: 'https://mcp.example.com' },
      },
    };
    const v = validateReservedServerNames(agent);
    expect(v).toHaveLength(1);
    expect(v.some((m) => m.includes('"guuey-memory"'))).toBe(true);
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

describe('AgentSectionV1.mode (guuey deploy routing declaration)', () => {
  it("accepts 'code'", () => {
    const r = AgentSectionV1.safeParse({ mode: 'code' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe('code');
  });
  it("accepts 'declarative'", () => {
    const r = AgentSectionV1.safeParse({ mode: 'declarative' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe('declarative');
  });
  it('is optional (absent is valid, stays absent — platform infers)', () => {
    const r = AgentSectionV1.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBeUndefined();
  });
  it('rejects junk values', () => {
    expect(AgentSectionV1.safeParse({ mode: 'nocode' }).success).toBe(false);
    expect(AgentSectionV1.safeParse({ mode: 'dockerfile' }).success).toBe(false);
    expect(AgentSectionV1.safeParse({ mode: true }).success).toBe(false);
    expect(AgentSectionV1.safeParse({ mode: 1 }).success).toBe(false);
  });
});

// ── Discriminated union schema tests ─────────────────────────────────────────

describe('McpServerSchema — each kind parses correctly', () => {
  function parseMcpServers(mcpServers: unknown) {
    return AgentSectionV1.parse({ mcpServers });
  }

  it('colocated: source required, devPort optional', () => {
    const r = parseMcpServers({
      tool: { kind: 'colocated', source: './mcps/tool', devPort: 6784 },
    });
    expect(r.mcpServers?.tool).toEqual({
      kind: 'colocated',
      source: './mcps/tool',
      devPort: 6784,
    });
  });

  it('colocated: no source → parse error', () => {
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

// ── guuey-profile reservation + profileAccess schema (profile T1) ──────────
//
// Sibling of the guuey-memory reservation above: `guuey-profile` is the
// RESERVED mcpServers key the profile MCP will be spliced under (a later
// task); reserving it now closes the same builder-shadow hole
// validateReservedServerNames already guards for guuey-memory.
// `profileAccess` is the agent-level opt-in (read vs read-write) that later
// tasks read off the resolved snapshot — an optional enum, same shape as
// `AuthSchema`/`MemorySchema`.

/** Minimal valid agent section — mirrors schema.test.ts's `minimalAgent`. */
const minimalAgent: GuueyAgent = {};

/** A plain external mcpServers entry, reused across reserved-name checks. */
const externalEntry: GuueyAgentMcpServer = { kind: 'external', url: 'https://mcp.example.com' };

/** Parse helper mirroring `parseMcpServers` above. */
function parseAgent(agent: unknown): GuueyAgent {
  return AgentSectionV1.parse(agent);
}

describe('guuey-profile reservation + profileAccess schema', () => {
  it('guuey-profile is reserved', () => {
    expect(RESERVED_MCP_SERVER_NAMES).toContain('guuey-profile');
    const violations = validateReservedServerNames({
      ...minimalAgent,
      mcpServers: { 'guuey-profile': externalEntry },
    });
    expect(violations).toHaveLength(1);
  });

  it('profileAccess parses as an optional enum', () => {
    expect(parseAgent({ ...minimalAgent, profileAccess: 'read-write' }).profileAccess).toBe(
      'read-write',
    );
    expect(() => parseAgent({ ...minimalAgent, profileAccess: 'write' })).toThrow();
    expect(parseAgent(minimalAgent).profileAccess).toBeUndefined();
  });
});
