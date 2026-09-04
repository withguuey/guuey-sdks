import { describe, expect, it } from 'vitest';
import {
  applyAgentMode,
  AgentSectionV1,
  validateColocatedServerNames,
  validateNoLiteralSecrets,
  validateReservedServerNames,
  validateToolGates,
  parseToolGateEntry,
  agentDeclaresVfs,
  RESERVED_MEMORY_SERVER_NAME,
  RESERVED_HANDOFF_SERVER_NAME,
  RESERVED_MCP_SERVER_NAMES,
  DEFAULT_AGENT_MCP_SERVERS,
  effectiveMcpServers,
  declaredServerEntries,
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

// ── validateReservedServerNames (deploy-time reserved-key rejection) ────────
//
// `guuey-memory` is a platform-RESERVED `mcpServers` key: the runtime splices
// the auto-injected memory MCP under it (memmcp). A builder-declared server of
// that name would boot as builder code under the same key AND be replaced by
// the platform entry at invoke time. This deploy-time pre-flight (mirrors
// `validateColocatedServerNames`'s shape) rejects it loudly; the run-seam collision
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

describe('agentDeclaresVfs — the per-agent half of fsBound (guuey#234)', () => {
  it('absent storage → the platform default → true', () => {
    expect(agentDeclaresVfs(undefined)).toBe(true);
    expect(agentDeclaresVfs({})).toBe(true);
  });
  it('storage: [] → "no VFS" → false (no file tools even on an armed pod)', () => {
    expect(agentDeclaresVfs({ storage: [] })).toBe(false);
  });
  it('any non-empty scope list → true', () => {
    expect(agentDeclaresVfs({ storage: ['user'] })).toBe(true);
    expect(agentDeclaresVfs({ storage: ['user', 'app'] })).toBe(true);
  });
});

describe('parseToolGateEntry — the ONE tool-gate grammar (guuey#234)', () => {
  it('"<server>.<tool>" → server-tool', () => {
    expect(parseToolGateEntry('todoist.create_task')).toEqual({
      kind: 'server-tool',
      server: 'todoist',
      tool: 'create_task',
    });
  });

  it('"<server>.*" → server-all', () => {
    expect(parseToolGateEntry('ggui.*')).toEqual({ kind: 'server-all', server: 'ggui' });
  });

  it('a bare name → bare (matches every connected server + the built-in of that name)', () => {
    expect(parseToolGateEntry('search')).toEqual({ kind: 'bare', tool: 'search' });
    expect(parseToolGateEntry('Bash')).toEqual({ kind: 'bare', tool: 'Bash' });
  });

  it('a dotted tool name splits on the FIRST dot only', () => {
    expect(parseToolGateEntry('svc.ns.tool')).toEqual({
      kind: 'server-tool',
      server: 'svc',
      tool: 'ns.tool',
    });
  });

  it('rejects the framework-internal mcp__ spelling with a pointer to the grammar', () => {
    const r = parseToolGateEntry('mcp__ggui__render');
    expect('error' in r && r.error).toContain('<server>.<tool>');
  });

  it('rejects empty halves and partial wildcards', () => {
    expect('error' in parseToolGateEntry('.tool')).toBe(true);
    expect('error' in parseToolGateEntry('server.')).toBe(true);
    expect('error' in parseToolGateEntry('server.cre*')).toBe(true);
    expect('error' in parseToolGateEntry('   ')).toBe(true);
  });
});

describe('validateToolGates — deploy-time pre-flight (guuey#234)', () => {
  it('no tools block / undefined agent → clean', () => {
    expect(validateToolGates(undefined)).toEqual([]);
    expect(validateToolGates({})).toEqual([]);
    expect(validateToolGates({ tools: {} })).toEqual([]);
  });

  it('accepts entries against declared servers, the platform-default ggui, and reserved servers', () => {
    const agent: GuueyAgent = {
      mcpServers: { todoist: { kind: 'external', url: 'https://mcp.example.com' } },
      tools: {
        allowlist: ['todoist.create_task', 'ggui.*', 'search', `${RESERVED_MEMORY_SERVER_NAME}.save_memory`],
        denylist: ['todoist.delete_project', 'Bash'],
      },
    };
    expect(validateToolGates(agent)).toEqual([]);
  });

  it('with NO mcpServers declared, ggui is still a known server (the platform default)', () => {
    expect(validateToolGates({ tools: { allowlist: ['ggui.render'] } })).toEqual([]);
  });

  it('rejects a server the agent does not connect — and names the ones it does', () => {
    const agent: GuueyAgent = {
      mcpServers: { todoist: { kind: 'external', url: 'https://mcp.example.com' } },
      tools: { allowlist: ['linear.create_issue'] },
    };
    const v = validateToolGates(agent);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('tools.allowlist');
    expect(v[0]).toContain('"linear"');
    expect(v[0]).toContain('todoist');
    expect(v[0]).toContain('ggui');
  });

  it('honours the ggui: false opt-out — "ggui.*" is then unknown', () => {
    const agent: GuueyAgent = { mcpServers: { ggui: false }, tools: { allowlist: ['ggui.*'] } };
    expect(validateToolGates(agent)).toHaveLength(1);
  });

  it('rejects the mcp__ spelling and malformed entries in BOTH lists, one message each', () => {
    const agent: GuueyAgent = {
      tools: { allowlist: ['mcp__ggui__render', 'ggui.'], denylist: ['.x'] },
    };
    const v = validateToolGates(agent);
    expect(v).toHaveLength(3);
    expect(v.filter((m) => m.startsWith('tools.allowlist:'))).toHaveLength(2);
    expect(v.filter((m) => m.startsWith('tools.denylist:'))).toHaveLength(1);
  });

  it('bare names are never server-checked (they resolve against whatever connects at turn time)', () => {
    expect(validateToolGates({ tools: { allowlist: ['anything_at_all'] } })).toEqual([]);
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

  it("kind: 'proxied' is gone (guuey#178 D1) — the schema rejects it", () => {
    expect(() =>
      parseMcpServers({ gmail: { kind: 'proxied', connection: 'gmail' } }),
    ).toThrow();
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

describe("mcpServers ggui:false opt-out (guuey#24)", () => {
  const todo = { kind: "colocated", source: "./mcps/todo" } as const;

  it("schema accepts false for the ggui key only", () => {
    expect(() =>
      AgentSectionV1.parse({
        mode: "code",
        framework: "claude-agent-sdk",
        mcpServers: { ggui: false, todo },
      })
    ).not.toThrow();
  });

  it("schema rejects false for any other key, naming the key", () => {
    const r = AgentSectionV1.safeParse({
      mode: "code",
      framework: "claude-agent-sdk",
      mcpServers: { todo: false },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("todo");
  });

  it("effectiveMcpServers seeds the default under a declared-only map", () => {
    expect(effectiveMcpServers({ todo })).toEqual({
      ggui: DEFAULT_AGENT_MCP_SERVERS.ggui,
      todo,
    });
  });

  it("effectiveMcpServers: a declared ggui entry wins over the default", () => {
    const mine = {
      kind: "external",
      url: "https://mcp.ggui.ai",
      transport: "http",
      headers: { "x-custom": "v" },
    } as const;
    expect(effectiveMcpServers({ ggui: mine }).ggui).toEqual(mine);
  });

  it("effectiveMcpServers: ggui:false drops the default entirely", () => {
    expect(effectiveMcpServers({ ggui: false, todo })).toEqual({ todo });
  });

  it("effectiveMcpServers: undefined and empty behave as today (default applies)", () => {
    expect(effectiveMcpServers(undefined)).toEqual(DEFAULT_AGENT_MCP_SERVERS);
    expect(effectiveMcpServers({})).toEqual(DEFAULT_AGENT_MCP_SERVERS);
  });

  it("declaredServerEntries filters the false entry and keeps real ones", () => {
    expect(declaredServerEntries({ ggui: false, todo })).toEqual([["todo", todo]]);
    expect(declaredServerEntries(undefined)).toEqual([]);
  });
});

describe("credential: 'caller' (guuey#179 — the third credential source)", () => {
  it('parses on a plain external entry', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://mcp.ggui.ai/control',
          transport: 'http',
          credential: 'caller',
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('coexists with static headers (merged under the forwarded authorization)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://api.example.com',
          credential: 'caller',
          headers: { 'X-Tenant': 'acme' },
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects credential:caller combined with federate:true', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://mcp.ggui.ai/control',
          credential: 'caller',
          federate: true,
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain('cannot be combined with federate');
    }
  });

  it('credential:caller with federate:false is fine (explicit non-federation)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://mcp.ggui.ai/control',
          credential: 'caller',
          federate: false,
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects any credential value other than 'caller' / 'oauth'", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: { kind: 'external', url: 'https://api.example.com', credential: 'apiKey' },
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects credential on non-external kinds (strict objects)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        tools: { kind: 'colocated', source: './mcp', credential: 'caller' },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("credential: 'oauth' (guuey#178 — the third-party OAuth broker arm)", () => {
  it('parses on a plain external entry — URL + credential is the whole declaration', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: { kind: 'external', url: 'https://mcp.linear.app/mcp', credential: 'oauth' },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mcpServers?.linear).toEqual({
        kind: 'external',
        url: 'https://mcp.linear.app/mcp',
        credential: 'oauth',
      });
    }
  });

  it('accepts the INTERNAL lowered shape (mcpResourceUrl = the brokered gateway route)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          mcpResourceUrl: 'https://mcp.dev.sandbox.guuey.com/brokered/app_1/linear/',
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('coexists with non-authorization static headers', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          headers: { 'X-Tenant': 'acme' },
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects credential:oauth combined with federate:true', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          federate: true,
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain("credential: 'oauth' cannot be combined with federate");
    }
  });

  it('rejects credential:oauth combined with a declared authorization header (any casing)', () => {
    for (const name of ['authorization', 'Authorization', 'AUTHORIZATION']) {
      const r = AgentSectionV1.safeParse({
        mcpServers: {
          linear: {
            kind: 'external',
            url: 'https://mcp.linear.app/mcp',
            credential: 'oauth',
            headers: { [name]: 'Bearer ${env.LINEAR_TOKEN}' },
          },
        },
      });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain('cannot be combined with an `authorization` header');
      }
    }
  });

  it('rejects credential on non-external kinds (strict objects)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        reg: { kind: 'hosted', server: 'srv-1', credential: 'oauth' },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("authMode — WHEN the oauth sign-in is demanded (guuey#605)", () => {
  it("parses beside credential: 'oauth' and survives the round-trip", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          authMode: 'upfront',
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mcpServers?.linear).toEqual({
        kind: 'external',
        url: 'https://mcp.linear.app/mcp',
        credential: 'oauth',
        authMode: 'upfront',
      });
    }
  });

  it('parses on the INTERNAL lowered shape too (mcpResourceUrl present)', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          authMode: 'upfront',
          mcpResourceUrl: 'https://mcp.dev.sandbox.guuey.com/brokered/app_1/linear/',
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it("is schema-refused WITHOUT credential: 'oauth' (no credential declared)", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: { kind: 'external', url: 'https://mcp.linear.app/mcp', authMode: 'upfront' },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain(
        "authMode is only valid beside credential: 'oauth'",
      );
    }
  });

  it("is schema-refused beside credential: 'caller' (only the oauth arm has a sign-in to front-load)", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://mcp.ggui.ai/control',
          credential: 'caller',
          authMode: 'upfront',
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain(
        "authMode is only valid beside credential: 'oauth'",
      );
    }
  });

  it('rejects authMode on non-external kinds and any value outside the pair (strict objects)', () => {
    expect(
      AgentSectionV1.safeParse({
        mcpServers: { reg: { kind: 'hosted', server: 'srv-1', authMode: 'upfront' } },
      }).success,
    ).toBe(false);
    expect(
      AgentSectionV1.safeParse({
        mcpServers: {
          linear: {
            kind: 'external',
            url: 'https://mcp.linear.app/mcp',
            credential: 'oauth',
            authMode: 'deferred',
          },
        },
      }).success,
    ).toBe(false);
  });

  // The 'lazy' arm: the default said out loud. It must PARSE (a config that
  // states which flavor it means is not an error) and it must mean exactly
  // what omitting the key means — the deploy-controller normalizes it away,
  // pinned in `resolve-mcp.test.ts`, so no pod ever sees the literal.
  it("parses authMode: 'lazy' beside credential: 'oauth' and keeps it on the parsed entry", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: {
          kind: 'external',
          url: 'https://mcp.linear.app/mcp',
          credential: 'oauth',
          authMode: 'lazy',
        },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mcpServers?.linear).toEqual({
        kind: 'external',
        url: 'https://mcp.linear.app/mcp',
        credential: 'oauth',
        authMode: 'lazy',
      });
    }
  });

  it("refuses authMode: 'lazy' away from credential: 'oauth' too — the refusal is about the FIELD, not the value", () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        control: {
          kind: 'external',
          url: 'https://mcp.ggui.ai/control',
          credential: 'caller',
          authMode: 'lazy',
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toContain(
        "authMode is only valid beside credential: 'oauth'",
      );
    }
  });

  it('omitting authMode entirely stays valid — absent is the default, and no value is invented for it', () => {
    const r = AgentSectionV1.safeParse({
      mcpServers: {
        linear: { kind: 'external', url: 'https://mcp.linear.app/mcp', credential: 'oauth' },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mcpServers?.linear).not.toHaveProperty('authMode');
    }
  });
});

describe('agent.modes — multi-mode agent (guuey#527)', () => {
  it('accepts the default rep/agent pair: append + a tool subset + audience', () => {
    const r = AgentSectionV1.safeParse({
      systemPrompt: 'You are the helper.',
      tools: { allowlist: ['docs.*', 'platform.whoami', 'ggui.*'] },
      defaultMode: 'agent',
      modes: {
        rep: {
          systemPromptAppend: 'You are talking to a website visitor — be concise.',
          tools: { allowlist: ['docs.*'] },
          audience: ['guest'],
        },
        agent: { audience: ['authenticated', 'byo'] },
      },
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS a mode whose tool is not permitted by the base allowlist (the subset rule)', () => {
    const r = AgentSectionV1.safeParse({
      tools: { allowlist: ['docs.*'] },
      modes: { rep: { tools: { allowlist: ['docs.search', 'platform.deploy'] } } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toMatch(/base agent\.tools\.allowlist does not permit/);
      expect(r.error.issues[0]?.path).toEqual(['modes', 'rep', 'tools', 'allowlist']);
    }
  });

  it('a base wildcard covers a mode’s narrower tool (platform.* permits platform.whoami)', () => {
    const r = AgentSectionV1.safeParse({
      tools: { allowlist: ['platform.*'] },
      modes: { rep: { tools: { allowlist: ['platform.whoami'] } } },
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS a mode declaring BOTH systemPromptAppend and systemPrompt', () => {
    const r = AgentSectionV1.safeParse({
      modes: { rep: { systemPromptAppend: 'a', systemPrompt: 'b' } },
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS a defaultMode that is not a declared mode', () => {
    const r = AgentSectionV1.safeParse({
      defaultMode: 'ghost',
      modes: { agent: {} },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'defaultMode')).toBe(true);
  });

  it('no base allowlist ⇒ any mode tool is permitted (a mode still narrows "anything")', () => {
    const r = AgentSectionV1.safeParse({
      modes: { rep: { tools: { allowlist: ['docs.search'] } } },
    });
    expect(r.success).toBe(true);
  });
});

describe('RESERVED_HANDOFF_SERVER_NAME (guuey#552 A1)', () => {
  it('is guuey-handoff, rides the reserved set, and a builder declaring it is refused at deploy', () => {
    expect(RESERVED_HANDOFF_SERVER_NAME).toBe('guuey-handoff');
    expect(RESERVED_MCP_SERVER_NAMES).toContain(RESERVED_HANDOFF_SERVER_NAME);
    const violations = validateReservedServerNames({
      mcpServers: {
        [RESERVED_HANDOFF_SERVER_NAME]: { kind: 'colocated', source: './mcps/handoff' },
      },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('guuey-handoff');
    expect(violations[0]).toContain('reserved');
  });
});

describe('applyAgentMode (guuey#566 — the guest/auth axis, server-derived + pin-within-permission)', () => {
  const base: GuueyAgent = {
    systemPrompt: 'BASE',
    tools: { allowlist: ['mcp__ggui__*', 'Read'] },
    modes: {
      guest: {},
      auth: { systemPromptAppend: 'CONSOLE CONTEXT', tools: { allowlist: ['Read'] } },
    },
  };

  it('no modes declared → same reference, applied null', () => {
    const bare: GuueyAgent = { systemPrompt: 'X' };
    const r = applyAgentMode(bare, undefined, 'guest');
    expect(r.agent).toBe(bare);
    expect(r.applied).toBeNull();
  });

  it('SERVER-DERIVED: an authed caller gets auth mode (base + append, subset applied) with NO pin', () => {
    const r = applyAgentMode(base, undefined, 'auth');
    expect(r.applied).toBe('auth');
    expect(r.agent.systemPrompt).toBe('BASE\n\nCONSOLE CONTEXT');
    expect(r.agent.tools).toEqual({ allowlist: ['Read'] });
    expect(base.systemPrompt).toBe('BASE'); // never mutates
  });

  it('a guest derives guest — the EMPTY def serves the base by SAME REFERENCE', () => {
    const r = applyAgentMode(base, undefined, 'guest');
    expect(r.applied).toBe('guest');
    expect(r.agent).toBe(base);
  });

  it('PIN WITHIN PERMISSION: authed may pin guest (preview-as-visitor)', () => {
    const r = applyAgentMode(base, 'guest', 'auth');
    expect(r.applied).toBe('guest');
    expect(r.agent).toBe(base);
    expect(r.fallback).toBeUndefined();
  });

  it('a GUEST pinning auth is CLAMPED to guest — structurally cannot claim auth mode', () => {
    const r = applyAgentMode(base, 'auth', 'guest');
    expect(r.applied).toBe('guest');
    expect(r.fallback).toBe('pin-clamped');
    expect(r.agent).toBe(base); // guest def is empty → base
  });

  it('an unrecognized pin key is ignored — pure derivation stands, warned as unknown-mode', () => {
    const r = applyAgentMode(base, 'rep', 'auth');
    expect(r.applied).toBe('auth');
    expect(r.fallback).toBe('unknown-mode');
    expect(r.agent.systemPrompt).toBe('BASE\n\nCONSOLE CONTEXT');
  });

  it('FALLBACK CHAIN: an undeclared auth mode falls to the guest def (hire-a-rep by construction)', () => {
    const guestOnly: GuueyAgent = {
      systemPrompt: 'BASE',
      modes: { guest: { systemPrompt: 'REP VOICE' } },
    };
    const r = applyAgentMode(guestOnly, undefined, 'auth');
    expect(r.applied).toBe('guest');
    expect(r.fallback).toBe('auth-undeclared');
    expect(r.agent.systemPrompt).toBe('REP VOICE');
  });

  it('nothing declared for the chain → base, applied null', () => {
    const authOnly: GuueyAgent = { systemPrompt: 'BASE', modes: { auth: { systemPrompt: 'A' } } };
    const r = applyAgentMode(authOnly, undefined, 'guest');
    expect(r.applied).toBeNull();
    expect(r.agent).toBe(authOnly);
  });

  it('deprecated defaultMode is NOT consulted', () => {
    const withDefault: GuueyAgent = {
      systemPrompt: 'BASE',
      defaultMode: 'auth',
      modes: { guest: { systemPrompt: 'REP' }, auth: { systemPrompt: 'AUTH' } },
    };
    // A guest derives guest regardless of defaultMode.
    expect(applyAgentMode(withDefault, undefined, 'guest').agent.systemPrompt).toBe('REP');
  });

  it('a { file } mode prompt is unusable at serve time → base, never a path-as-prompt', () => {
    const fileMode: GuueyAgent = {
      systemPrompt: 'BASE',
      modes: { guest: { systemPrompt: { file: './p.md' } } },
    };
    const r = applyAgentMode(fileMode, undefined, 'guest');
    expect(r.applied).toBeNull();
    expect(r.agent.systemPrompt).toBe('BASE');
  });
});

describe('agent.surfaceHints — the guuey#531 opt-out knob', () => {
  it('parses false (BYO plain-text surfaces) and absent defaults to undefined (ON downstream)', () => {
    const off = AgentSectionV1.parse({ surfaceHints: false });
    expect(off.surfaceHints).toBe(false);
    const def = AgentSectionV1.parse({});
    expect(def.surfaceHints).toBeUndefined();
  });
});
