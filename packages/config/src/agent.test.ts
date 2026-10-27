import { describe, expect, it } from 'vitest';
import {
  isGguiHost,
  isGguiRenderUrl,
  isGguiUrl,
  applyAgentMode,
  AgentSectionV1,
  validateColocatedServerNames,
  validateNoLiteralSecrets,
  validateReservedServerNames,
  validateReservedPlatformNames,
  validateCallerCredentialHttps,
  validateFederateResourceUrl,
  validateToolGates,
  validateSubmittedToolGates,
  validateToolAllowlistsNotEmpty,
  validateNoToolsEntry,
  declaresNoTools,
  NO_TOOLS_ENTRY,
  EVERY_TOOL_ENTRY,
  parseToolGateEntry,
  agentDeclaresVfs,
  RESERVED_MEMORY_SERVER_NAME,
  RESERVED_HANDOFF_SERVER_NAME,
  RESERVED_MCP_SERVER_NAMES,
  RESERVED_PLATFORM_NAMES,
  toolGateServerNames,
  DEFAULT_AGENT_MCP_SERVERS,
  effectiveMcpServers,
  declaredServerEntries,
  type GuueyAgent,
  type GuueyAgentMcpServer,
} from './agent.js';
import { safeParseGuueyJson } from './schema.js';

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

// ── Reserved platform names (guuey#2393) ─────────────────────────────────────
//
// `guuey-media` is a name the platform uses itself, with no server spliced
// under it. A newly written document declaring the key is refused whatever its
// kind; a stored one keeps loading (validateReservedServerNames,
// which every stored snapshot passes through, does not name it), and the
// tool-gate grammar never names it (there is no platform server behind it to
// gate).

describe('RESERVED_PLATFORM_NAMES — the guuey-media name (guuey#2393)', () => {
  it('a guuey.json declaring a guuey-media server is refused, whatever its kind', () => {
    for (const entry of [
      { kind: 'colocated', source: './mcps/media' },
      { kind: 'external', url: 'https://mcp.example.com' },
    ] satisfies GuueyAgentMcpServer[]) {
      const v = validateReservedPlatformNames({ mcpServers: { 'guuey-media': entry, fine: entry } });
      expect(v).toEqual(['MCP server "guuey-media": that name is reserved by the platform — rename this server.']);
    }
    expect(validateReservedPlatformNames(undefined)).toEqual([]);
    expect(validateReservedPlatformNames({ mcpServers: { [RESERVED_MEMORY_SERVER_NAME]: { kind: 'colocated', source: './a' } } })).toEqual([]);
  });

  it('validateReservedServerNames does not refuse guuey-media, so a stored snapshot declaring it still passes the lints every deploy runs', () => {
    expect(
      validateReservedServerNames({ mcpServers: { 'guuey-media': { kind: 'external', url: 'https://mcp.example.com' } } }),
    ).toEqual([]);
  });

  it('is a reserved name, not a platform server: the tool-gate grammar does not name it', () => {
    expect(RESERVED_PLATFORM_NAMES).toEqual(['guuey-media']);
    expect(RESERVED_MCP_SERVER_NAMES).not.toContain('guuey-media');
    expect(toolGateServerNames({})).not.toContain('guuey-media');
    const v = validateToolGates({ tools: { allowlist: ['guuey-media.sign'] } });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"guuey-media"');
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

  it('"*" is valid only as the whole tool part and as the whole entry; anywhere else the entry is malformed (guuey#2585)', () => {
    expect(parseToolGateEntry(' * ')).toEqual({ kind: 'bare', tool: EVERY_TOOL_ENTRY });
    expect(parseToolGateEntry('svc.*')).toEqual({ kind: 'server-all', server: 'svc' });
    for (const entry of ['*.*', '*.tool', 'sv*.tool', 's*.*', 'delete_*', '*search', 'a*b', '**']) {
      const r = parseToolGateEntry(entry);
      expect('error' in r && r.error, entry).toContain(
        '"*" is only valid as the whole entry ("*") or as the whole tool part ("<server>.*")',
      );
    }
    // A "*" inside a dotted entry's tool part keeps the refusal it always had.
    for (const entry of ['svc.cre*', 'sv*.cre*']) {
      const r = parseToolGateEntry(entry);
      expect('error' in r && r.error, entry).toContain('wildcards are only valid as the whole tool part');
    }
  });

  it('validateToolGates (every snapshot, stored ones too) lets a misplaced "*" through, as it did before guuey#2585', () => {
    expect(validateToolGates({ tools: { allowlist: ['*', 'ggui.*'], denylist: ['*'] } })).toEqual([]);
    expect(validateToolGates({ tools: { allowlist: ['delete_*', '**'], denylist: ['a*b'] } })).toEqual([]);
    const declared: GuueyAgent = {
      mcpServers: { 'S*': { kind: 'external', url: 'https://mcp.example.com' } },
      tools: { allowlist: ['S*.a', 'S*.*'] },
    };
    expect(validateToolGates(declared)).toEqual([]);
  });

  it('validateToolGates still refuses a misplaced-"*" entry whose server is not connected, and a "*" inside the tool part', () => {
    const v = validateToolGates({ tools: { allowlist: ['*.*', 'gg*.render'], denylist: ['ggui.ren*'] } });
    expect(v).toEqual([
      expect.stringMatching(/^tools\.allowlist: "\*\.\*" names MCP server "\*", which this agent does not connect/),
      expect.stringMatching(/^tools\.allowlist: "gg\*\.render" names MCP server "gg\*"/),
      expect.stringMatching(/^tools\.denylist: .*wildcards are only valid as the whole tool part/),
    ]);
  });
});

describe('validateSubmittedToolGates — the refusals for a document submitted now (guuey#2585)', () => {
  const PLACES = '"*" is only valid as the whole entry ("*") or as the whole tool part ("<server>.*")';

  it('a clean document, and the two valid "*" places, → clean', () => {
    expect(validateSubmittedToolGates(undefined)).toEqual([]);
    expect(validateSubmittedToolGates({})).toEqual([]);
    expect(
      validateSubmittedToolGates({
        tools: { allowlist: ['*', 'ggui.*', 'search'], denylist: ['*'] },
        modes: { guest: { tools: { allowlist: ['@none'], denylist: ['ggui.render', 'Bash', '*'] } } },
      }),
    ).toEqual([]);
  });

  it('refuses a misplaced "*" on the base, one message per entry, naming the path', () => {
    expect(
      validateSubmittedToolGates({ tools: { allowlist: ['delete_*', '*.*'], denylist: ['S*.a'] } }),
    ).toEqual([
      `agent.tools.allowlist: "delete_*": ${PLACES}, never inside a bare tool name`,
      `agent.tools.allowlist: "*.*": ${PLACES}, never in the server name`,
      `agent.tools.denylist: "S*.a": ${PLACES}, never in the server name`,
    ]);
  });

  it('leaves the rest of the base grammar to validateToolGates (no double message)', () => {
    expect(
      validateSubmittedToolGates({ tools: { allowlist: ['mcp__ggui__render', 'linear.x', 'ggui.'] } }),
    ).toEqual([]);
  });

  it("checks a mode's lists by the whole grammar: a misplaced \"*\", a malformed entry, an unconnected server", () => {
    const agent: GuueyAgent = {
      mcpServers: { todoist: { kind: 'external', url: 'https://mcp.example.com' } },
      modes: {
        guest: { tools: { allowlist: ['todoist.add', 'delete_*'], denylist: ['mcp__todoist__x'] } },
        admin: { tools: { allowlist: ['linear.create_issue', `${RESERVED_MEMORY_SERVER_NAME}.save_memory`] } },
      },
    };
    expect(validateSubmittedToolGates(agent)).toEqual([
      `agent.modes.guest.tools.allowlist: "delete_*": ${PLACES}, never inside a bare tool name`,
      expect.stringMatching(/^agent\.modes\.guest\.tools\.denylist: "mcp__todoist__x" uses the framework-internal spelling/),
      'agent.modes.admin.tools.allowlist: "linear.create_issue" names MCP server "linear", which this agent does not connect — declare it under mcpServers',
    ]);
  });

  it('each message depends only on its path and entry: the server list never appears in it', () => {
    const one = validateSubmittedToolGates({ modes: { m: { tools: { allowlist: ['x.a'] } } } });
    const two = validateSubmittedToolGates({
      mcpServers: { todoist: { kind: 'external', url: 'https://mcp.example.com' } },
      modes: { m: { tools: { allowlist: ['x.a'] } } },
    });
    expect(one).toEqual(two);
    expect(one).toHaveLength(1);
  });

  it('a mode entry naming ggui (the platform default) is clean; ggui: false makes it unknown', () => {
    expect(validateSubmittedToolGates({ modes: { m: { tools: { allowlist: ['ggui.render'] } } } })).toEqual([]);
    expect(
      validateSubmittedToolGates({ mcpServers: { ggui: false }, modes: { m: { tools: { allowlist: ['ggui.render'] } } } }),
    ).toHaveLength(1);
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

describe('validateToolAllowlistsNotEmpty — deploy-time refusal of an empty allowlist (guuey#2258)', () => {
  it('refuses a present-but-empty base allowlist with the message', () => {
    expect(validateToolAllowlistsNotEmpty({ tools: { allowlist: [] } })).toEqual([
      'agent.tools.allowlist is empty, which allows every tool; omit it to allow every tool, ' +
        'list the tools to allow, write ["@none"] to allow no tools, ' +
        'or deny-list servers with "<server>.*" in agent.tools.denylist',
    ]);
  });

  it('refuses a present-but-empty mode allowlist, naming the mode', () => {
    const v = validateToolAllowlistsNotEmpty({
      tools: { allowlist: ['ggui.*'] },
      modes: { guest: { tools: { allowlist: [] } }, auth: { tools: { allowlist: ['ggui.render'] } } },
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('agent.modes.guest.tools.allowlist is empty, and an empty allowlist never means "no tools" in mode "guest"');
    expect(v[0]).toContain('agent.modes.guest.tools.denylist');
    expect(v[0]).toContain('write ["@none"] to allow no tools in this mode');
  });

  it('passes ["@none"] (one entry, so never empty) on the base and in a mode (guuey#2262)', () => {
    expect(
      validateToolAllowlistsNotEmpty({ tools: { allowlist: ['@none'] }, modes: { guest: { tools: { allowlist: ['@none'] } } } }),
    ).toEqual([]);
  });

  it('passes an absent allowlist, a non-empty one, an empty denylist alone, and modes without an allowlist', () => {
    expect(validateToolAllowlistsNotEmpty(undefined)).toEqual([]);
    expect(validateToolAllowlistsNotEmpty({})).toEqual([]);
    expect(validateToolAllowlistsNotEmpty({ tools: {} })).toEqual([]);
    expect(validateToolAllowlistsNotEmpty({ tools: { allowlist: ['ggui.*'] } })).toEqual([]);
    expect(validateToolAllowlistsNotEmpty({ tools: { denylist: [] } })).toEqual([]);
    expect(
      validateToolAllowlistsNotEmpty({ modes: { guest: { systemPromptAppend: 'x' }, auth: { tools: { denylist: ['Bash'] } } } }),
    ).toEqual([]);
  });

  it('is NOT a grammar violation: validateToolGates (which also runs on re-served stored snapshots) stays clean on []', () => {
    expect(validateToolGates({ tools: { allowlist: [] } })).toEqual([]);
  });

  it('N−1: a stored definition with allowlist: [] (base and mode) still parses through the load schema, [] kept as written', () => {
    const r = safeParseGuueyJson({
      schema: '1',
      agent: { systemPrompt: 'x', tools: { allowlist: [] }, modes: { guest: { tools: { allowlist: [] } } } },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.agent.tools?.allowlist).toEqual([]);
    expect(r.data.agent.modes?.['guest']?.tools?.allowlist).toEqual([]);
  });
});

describe('the "no tools" declaration, ["@none"] (guuey#2262)', () => {
  it('NO_TOOLS_ENTRY is "@none" and parses as a bare entry (no schema change, every shipped parser accepts it)', () => {
    expect(NO_TOOLS_ENTRY).toBe('@none');
    expect(parseToolGateEntry(NO_TOOLS_ENTRY)).toEqual({ kind: 'bare', tool: '@none' });
    expect(validateToolGates({ tools: { allowlist: ['@none'] } })).toEqual([]);
  });

  describe('declaresNoTools', () => {
    it('is true when every (trimmed) allowlist entry is "@none"', () => {
      expect(declaresNoTools({ allowlist: ['@none'] })).toBe(true);
      expect(declaresNoTools({ allowlist: [' @none '] })).toBe(true);
      expect(declaresNoTools({ allowlist: ['@none', '@none'] })).toBe(true);
      expect(declaresNoTools({ allowlist: ['@none'], denylist: ['Bash'] })).toBe(true);
    });

    it('is false for an absent block, an absent or empty allowlist, a mixed list, and a denylist-only "@none"', () => {
      expect(declaresNoTools(undefined)).toBe(false);
      expect(declaresNoTools({})).toBe(false);
      expect(declaresNoTools({ allowlist: [] })).toBe(false);
      expect(declaresNoTools({ allowlist: ['@none', 'ggui.render'] })).toBe(false);
      expect(declaresNoTools({ allowlist: ['ggui.*'] })).toBe(false);
      expect(declaresNoTools({ denylist: ['@none'] })).toBe(false);
    });
  });

  describe('validateNoToolsEntry', () => {
    it('allows a base ["@none"] (a prompt-only agent with no tools anywhere) and a mode ["@none"]', () => {
      expect(validateNoToolsEntry({ tools: { allowlist: ['@none'] } })).toEqual([]);
      expect(
        validateNoToolsEntry({
          modes: { connector: { tools: { allowlist: ['@none'], denylist: ['Read', 'Write', 'Bash'] } } },
        }),
      ).toEqual([]);
    });

    it('passes definitions that never write "@none"', () => {
      expect(validateNoToolsEntry(undefined)).toEqual([]);
      expect(validateNoToolsEntry({})).toEqual([]);
      expect(validateNoToolsEntry({ tools: { allowlist: ['ggui.*'], denylist: ['Bash'] } })).toEqual([]);
      expect(validateNoToolsEntry({ tools: { allowlist: [] } })).toEqual([]);
    });

    it('refuses "@none" mixed with other base allowlist entries', () => {
      const v = validateNoToolsEntry({ tools: { allowlist: ['@none', 'ggui.render'] } });
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('agent.tools.allowlist mixes "@none" with other entries');
      expect(v[0]).toContain("must be the allowlist's only entry");
    });

    it('refuses "@none" in the base denylist', () => {
      const v = validateNoToolsEntry({ tools: { denylist: ['@none'] } });
      expect(v).toHaveLength(1);
      expect(v[0]).toContain('agent.tools.denylist lists "@none"');
      expect(v[0]).toContain('agent.tools.allowlist: ["@none"]');
    });

    it('refuses both shapes in a mode, naming the mode, and checks every mode', () => {
      const v = validateNoToolsEntry({
        modes: {
          connector: { tools: { allowlist: ['x', ' @none'], denylist: ['@none'] } },
          guest: { tools: { allowlist: ['@none'] } },
        },
      });
      expect(v).toHaveLength(2);
      expect(v[0]).toContain('agent.modes.connector.tools.allowlist mixes "@none" with other entries in mode "connector"');
      expect(v[1]).toContain('agent.modes.connector.tools.denylist lists "@none" in mode "connector"');
    });

    it('is NOT a grammar or schema rule: validateToolGates and the load schema accept the mixed and denylist shapes', () => {
      const agent = { tools: { allowlist: ['@none', 'search'], denylist: ['@none'] } };
      expect(validateToolGates(agent)).toEqual([]);
      expect(safeParseGuueyJson({ schema: '1', agent: { systemPrompt: 'x', ...agent } }).success).toBe(true);
    });

    it('each message depends on its path alone (the server gate compares messages to find what a stored snapshot already carried)', () => {
      const a = validateNoToolsEntry({ tools: { allowlist: ['@none', 'a'] } });
      const b = validateNoToolsEntry({ tools: { allowlist: ['b', '@none', 'c'] } });
      expect(a).toEqual(b);
    });
  });

  it('N−1: a stored "@none" base and mode load through safeParseGuueyJson unchanged', () => {
    const r = safeParseGuueyJson({
      schema: '1',
      agent: {
        systemPrompt: 'x',
        tools: { allowlist: ['@none'] },
        modes: { guest: { tools: { allowlist: ['@none'] } } },
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.agent.tools?.allowlist).toEqual(['@none']);
    expect(r.data.agent.modes?.['guest']?.tools?.allowlist).toEqual(['@none']);
    expect(declaresNoTools(r.data.agent.tools)).toBe(true);
  });

  it('N−1: a stored "@none" mode under a base with no allowlist loads, and applyAgentMode serves it as no tools', () => {
    const r = safeParseGuueyJson({
      schema: '1',
      agent: {
        systemPrompt: 'x',
        modes: { guest: { tools: { allowlist: ['@none'], denylist: ['Bash'] } } },
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const served = applyAgentMode(r.data.agent, undefined, 'guest');
    expect(declaresNoTools(served.agent.tools)).toBe(true);
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

  it("effectiveMcpServers: a ggui server declared under ANOTHER key suppresses the seeded default — one ggui entry, the builder's key (guuey#955)", () => {
    const legacy = { kind: "external", url: "https://mcp.ggui.ai", transport: "http" } as const;
    const out = effectiveMcpServers({ "mcp-ggui-protocol": legacy });
    expect(Object.keys(out)).toEqual(["mcp-ggui-protocol"]);
    expect(out["mcp-ggui-protocol"]).toEqual(legacy);
  });

  it("effectiveMcpServers: the per-env sandbox ggui host counts as ggui too — no second entry (guuey#955)", () => {
    const sandbox = { kind: "external", url: "https://dev.mcp.sandbox.ggui.ai", transport: "http" } as const;
    expect(Object.keys(effectiveMcpServers({ ui: sandbox, todo }))).toEqual(["ui", "todo"]);
  });

  it("effectiveMcpServers: a same-host SIBLING (the helper's /control, credential caller) is NOT the render server — the default still seeds beside it (guuey#955)", () => {
    const control = { kind: "external", url: "https://mcp.ggui.ai/control", credential: "caller" } as const;
    const out = effectiveMcpServers({ control });
    expect(Object.keys(out).sort()).toEqual(["control", "ggui"]);
    expect(out["ggui"]).toEqual(DEFAULT_AGENT_MCP_SERVERS["ggui"]);
  });

  it("effectiveMcpServers: an explicit per-app /apps/<id> address IS the render server — no second entry (guuey#955)", () => {
    const perApp = { kind: "external", url: "https://mcp.ggui.ai/apps/App1", transport: "http" } as const;
    expect(Object.keys(effectiveMcpServers({ ui: perApp }))).toEqual(["ui"]);
  });

  it("effectiveMcpServers: two ggui entries declared EXPLICITLY stay — the builder's choice is never silently dropped (guuey#955)", () => {
    const legacy = { kind: "external", url: "https://mcp.ggui.ai", transport: "http" } as const;
    const out = effectiveMcpServers({ "mcp-ggui-protocol": legacy, ggui: legacy });
    expect(Object.keys(out).sort()).toEqual(["ggui", "mcp-ggui-protocol"]);
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

describe('isGguiHost / isGguiUrl — the ONE ggui-host rule (guuey#953)', () => {
  it('matches the canonical prod host and the per-env sandbox hosts — by host, never by key', () => {
    expect(isGguiHost('mcp.ggui.ai')).toBe(true);
    expect(isGguiHost('dev.mcp.sandbox.ggui.ai')).toBe(true);
    expect(isGguiHost('staging.mcp.sandbox.ggui.ai')).toBe(true);
    expect(isGguiHost('mcp.ggui.ai.evil.example')).toBe(false);
    expect(isGguiHost('ggui.ai')).toBe(false);
    expect(isGguiUrl('https://mcp.ggui.ai/apps/app_x')).toBe(true);
    expect(isGguiUrl('https://mcp.example.com')).toBe(false);
    expect(isGguiUrl('not a url')).toBe(false);
  });

  it('the platform default is a ggui host by its own rule (the seam every consumer shares)', () => {
    const d = DEFAULT_AGENT_MCP_SERVERS['ggui'];
    expect(d !== undefined && d.kind === 'external' && isGguiUrl(d.url)).toBe(true);
  });
});

describe("isGguiRenderUrl — THE render server's shape, not merely the host (guuey#955)", () => {
  it("root of the ggui host (prod + per-env sandbox) and an explicit /apps/<id> address", () => {
    expect(isGguiRenderUrl("https://mcp.ggui.ai")).toBe(true);
    expect(isGguiRenderUrl("https://mcp.ggui.ai/")).toBe(true);
    expect(isGguiRenderUrl("https://staging.mcp.sandbox.ggui.ai")).toBe(true);
    expect(isGguiRenderUrl("https://mcp.ggui.ai/apps/App1")).toBe(true);
  });
  it("same-host siblings and other hosts are not", () => {
    expect(isGguiRenderUrl("https://mcp.ggui.ai/control")).toBe(false);
    expect(isGguiRenderUrl("https://mcp.ggui.ai/dev")).toBe(false);
    expect(isGguiRenderUrl("https://mcp.example.com")).toBe(false);
    expect(isGguiRenderUrl("nope")).toBe(false);
  });
});

describe('applyAgentMode — a mode tools block with no allowlist keeps the base allowlist (guuey#2268)', () => {
  const narrowBase = (modeTools: GuueyAgent['tools']): GuueyAgent => ({
    systemPrompt: 'BASE',
    tools: { allowlist: ['docs.search_docs', 'docs.read_doc'], denylist: ['Bash'] },
    modes: { guest: { tools: modeTools } },
  });

  it('a denylist-only mode subtracts from the base allowlist', () => {
    const r = applyAgentMode(narrowBase({ denylist: ['docs.read_doc'] }), undefined, 'guest');
    expect(r.applied).toBe('guest');
    expect(r.agent.tools).toEqual({ allowlist: ['docs.search_docs', 'docs.read_doc'], denylist: ['Bash', 'docs.read_doc'] });
  });

  it('an empty mode tools block keeps the base allowlist and the base denylist', () => {
    const r = applyAgentMode(narrowBase({}), undefined, 'guest');
    expect(r.agent.tools).toEqual({ allowlist: ['docs.search_docs', 'docs.read_doc'], denylist: ['Bash'] });
  });

  it('a mode allowlist still replaces the base allowlist, as before', () => {
    const r = applyAgentMode(narrowBase({ allowlist: ['docs.search_docs'] }), undefined, 'guest');
    expect(r.agent.tools).toEqual({ allowlist: ['docs.search_docs'], denylist: ['Bash'] });
  });

  it('a mode cannot re-allow a tool the base denies: the served denylist is the union, deduplicated', () => {
    const r = applyAgentMode(narrowBase({ denylist: ['Bash', 'docs.read_doc'] }), undefined, 'guest');
    expect(r.agent.tools).toEqual({ allowlist: ['docs.search_docs', 'docs.read_doc'], denylist: ['Bash', 'docs.read_doc'] });
  });

  it('an empty mode allowlist inherits the base allowlist, so it never widens past a narrow base', () => {
    const r = applyAgentMode(narrowBase({ allowlist: [] }), undefined, 'guest');
    expect(r.agent.tools).toEqual({ allowlist: ['docs.search_docs', 'docs.read_doc'], denylist: ['Bash'] });
  });

  it('an empty mode allowlist over a base with no allowlist serves as written (nothing to inherit)', () => {
    const agent: GuueyAgent = { systemPrompt: 'BASE', modes: { guest: { tools: { allowlist: [] } } } };
    const r = applyAgentMode(agent, undefined, 'guest');
    expect(r.agent.tools).toEqual({ allowlist: [] });
  });

  it('a base with no allowlist: the mode block serves as written (nothing to inherit)', () => {
    const agent: GuueyAgent = { systemPrompt: 'BASE', modes: { guest: { tools: { denylist: ['Bash'] } } } };
    const r = applyAgentMode(agent, undefined, 'guest');
    expect(r.agent.tools).toEqual({ denylist: ['Bash'] });
  });

  it('the base agent object is not mutated', () => {
    const agent = narrowBase({ denylist: ['docs.read_doc'] });
    const before = JSON.stringify(agent);
    applyAgentMode(agent, undefined, 'guest');
    expect(JSON.stringify(agent)).toBe(before);
  });
});

// ── validateCallerCredentialHttps (deploy-time https gate for credential: 'caller') ──

describe('validateCallerCredentialHttps', () => {
  const caller = (url: string): GuueyAgent => ({
    mcpServers: { crm: { kind: 'external', url, credential: 'caller' } },
  });

  it('passes an https:// caller entry, an absent map and non-caller entries', () => {
    expect(validateCallerCredentialHttps(caller('https://crm.example.com/mcp'))).toEqual([]);
    expect(validateCallerCredentialHttps(caller('HTTPS://crm.example.com/mcp'))).toEqual([]);
    expect(validateCallerCredentialHttps(undefined)).toEqual([]);
    expect(validateCallerCredentialHttps({})).toEqual([]);
    expect(
      validateCallerCredentialHttps({
        mcpServers: {
          plain: { kind: 'external', url: 'http://localhost:7000/mcp' },
          static: { kind: 'external', url: 'http://api.example.com/mcp', headers: { 'X-Tenant': 'a' } },
          tool: { kind: 'colocated', source: './mcps/tool' },
        },
      }),
    ).toEqual([]);
  });

  it('passes a caller entry whose host is a platform placeholder over https', () => {
    expect(validateCallerCredentialHttps(caller('https://${platform.mcpDomain}/control'))).toEqual([]);
  });

  it('refuses a caller entry on http://, naming the server key', () => {
    expect(validateCallerCredentialHttps(caller('http://crm.example.com/mcp'))).toEqual([
      'mcpServers.crm: credential: "caller" requires an https:// url — the user\'s bearer would travel in cleartext',
    ]);
  });

  it('refuses a caller entry whose url is not an https:// URL at all (an unresolved placeholder)', () => {
    expect(validateCallerCredentialHttps(caller('${env.CRM_URL}'))).toHaveLength(1);
  });

  it('reports one violation per offending entry', () => {
    const agent: GuueyAgent = {
      mcpServers: {
        a: { kind: 'external', url: 'http://a.example.com/mcp', credential: 'caller' },
        b: { kind: 'external', url: 'https://b.example.com/mcp', credential: 'caller' },
        c: { kind: 'external', url: 'http://c.example.com/mcp', credential: 'caller' },
      },
    };
    const v = validateCallerCredentialHttps(agent);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('mcpServers.a:');
    expect(v[1]).toContain('mcpServers.c:');
  });

  it('is a write-path lint only: a stored definition with an http:// caller entry still loads', () => {
    const stored = {
      schema: '1',
      agent: { mcpServers: { crm: { kind: 'external', url: 'http://crm.example.com/mcp', credential: 'caller' } } },
    };
    const parsed = safeParseGuueyJson(stored);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(validateCallerCredentialHttps(parsed.data.agent)).toHaveLength(1);
  });
});

// ── validateFederateResourceUrl (deploy-time resource shape for federate: true) ──

describe('validateFederateResourceUrl', () => {
  const federated = (url: string, mcpResourceUrl?: string): GuueyAgent => ({
    mcpServers: {
      crm: { kind: 'external', url, federate: true, ...(mcpResourceUrl !== undefined ? { mcpResourceUrl } : {}) },
    },
  });

  it('passes an https:// url ending in "/", an absent map and non-federated entries', () => {
    expect(validateFederateResourceUrl(federated('https://crm.example.com/mcp/'))).toEqual([]);
    expect(validateFederateResourceUrl(federated('https://${platform.mcpDomain}/crm/'))).toEqual([]);
    expect(validateFederateResourceUrl(undefined)).toEqual([]);
    expect(validateFederateResourceUrl({})).toEqual([]);
    expect(
      validateFederateResourceUrl({
        mcpServers: {
          plain: { kind: 'external', url: 'https://api.example.com/mcp' },
          caller: { kind: 'external', url: 'https://crm.example.com/mcp', credential: 'caller' },
          tool: { kind: 'colocated', source: './mcps/tool' },
        },
      }),
    ).toEqual([]);
  });

  it('refuses a federated url without a trailing "/", naming the server key', () => {
    const v = validateFederateResourceUrl(federated('https://crm.example.com/mcp'));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^mcpServers\.crm: "federate": true needs an https:\/\/ url ending in "\/"/);
  });

  it('refuses a federated http:// url (the mint takes https:// only)', () => {
    expect(validateFederateResourceUrl(federated('http://crm.example.com/mcp/'))).toHaveLength(1);
  });

  it('judges mcpResourceUrl when it is set, since that is the resource minted for', () => {
    expect(validateFederateResourceUrl(federated('https://crm.example.com/mcp', 'https://crm.example.com/mcp/'))).toEqual([]);
    expect(validateFederateResourceUrl(federated('https://crm.example.com/mcp/', 'https://crm.example.com/mcp'))).toHaveLength(1);
  });

  it('skips a ggui render server, which mints for its own app address', () => {
    expect(validateFederateResourceUrl(federated('https://mcp.ggui.ai'))).toEqual([]);
  });

  it('is a write-path lint only: a stored definition with a slash-less federated url still loads', () => {
    const stored = {
      schema: '1',
      agent: { mcpServers: { crm: { kind: 'external', url: 'https://crm.example.com/mcp', federate: true } } },
    };
    const parsed = safeParseGuueyJson(stored);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(validateFederateResourceUrl(parsed.data.agent)).toHaveLength(1);
  });
});
