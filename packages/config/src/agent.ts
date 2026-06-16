/**
 * `guuey.json#agent` — the agent section.
 *
 * The agent section describes the deployable agent: framework + model
 * + system prompt + MCP host config + platform-feature opt-ins + deploy
 * config. Read by `@guuey/host` at pod boot to construct the framework
 * adapter; read by `@guuey/cli` to validate before submitting a deploy.
 *
 * Lives inside `guuey.json` post-2026-05-25 platform-architecture merge
 * (slice 7.2). Previously a separate `agent.json` file. See
 * `docs/plans/2026-05-25-platform-architecture.md` §14.2 for the
 * field-by-field migration.
 *
 * **Minimal valid section** (all other fields default):
 *
 * ```jsonc
 * {
 *   "framework": "claude-agent-sdk",
 *   "model": "claude-sonnet-4-6",
 *   "systemPrompt": { "file": "prompts/system.md" }
 * }
 * ```
 *
 * Defaults applied by the pod runtime when fields are absent:
 * - `framework`   → `'claude-agent-sdk'`
 * - `mcpServers`  → `{ ggui: { url: 'https://mcp.ggui.ai' } }` (platform default; declaring `mcpServers` REPLACES this — not merged)
 * - `model`       → framework-chosen default (Claude SDK → `claude-sonnet-4-6`)
 * - `systemPrompt`→ `GUUEY_DEFAULT_SYSTEM_PROMPT` from `./system-prompt`
 * - `auth`        → `'anonymous'`
 * - `memory`      → `'thread'`
 * - `storage`     → `['user', 'app']`
 * - `endpoint`    → `{ kind: 'invoke', streaming: true }`
 * - `deploy`      → `{ size: 'xs', region: 'us-east-1' }`
 *
 * **Rules for extending:**
 *
 * 1. **Additive only within `schema: '1'` (top-level).** New optional fields on existing
 *    objects are safe. Breaking changes bump the file-level `schema` to `'2'`.
 * 2. **Framework-neutral by default.** Fields meaningful to only one adapter (e.g. Claude's
 *    `permissions`, OpenAI's `tools.functions`) belong on a `framework`-scoped sub-block.
 */
import { z } from 'zod';
import { AGENT_SIZES } from './hosting.js';

/**
 * Supported framework adapters. The pod runtime selects the matching
 * `@guuey/framework-*` adapter at boot. `vanilla` skips the framework
 * layer entirely — the agent loop is the bare Anthropic Messages API
 * call with manual MCP tool wiring. Useful for benchmarking and for
 * adapters not yet built.
 */
export const AGENT_FRAMEWORKS = [
  'claude-agent-sdk',
  'openai-agents-sdk',
  'google-adk',
  'vanilla',
] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

/**
 * MCP server transport for entries in `agent.mcpServers`. Stock pod ships
 * with `http` and `sse` out of the box. `stdio` is reserved for code-mode
 * agents that ship their own MCP binaries; the nocode runtime rejects
 * `stdio` at boot.
 */
const McpTransportSchema = z.enum(['http', 'sse', 'stdio']);

/**
 * A single MCP server entry inside `agent.mcpServers`.
 *
 * Two reference forms supported:
 *
 * - **Explicit URL** — `{ url: 'https://mcp.example.com' }` for external or
 *   guuey-hosted MCP servers reached directly.
 * - **Guuey-hosted slug ref** — `{ ref: 'guuey://<slug>' }` for MCP servers
 *   published to the guuey platform via `guuey.mcp.json`. The platform
 *   resolves the slug at deploy time and inlines the URL.
 *
 * `headers` is forwarded on every request. Values may use `${env.NAME}`
 * placeholders — the pod's env-substitution pass fills them from the
 * deploy env block. Secrets MUST be referenced via `${env.NAME}` and
 * declared in `agent.secrets`, never literal-inlined here.
 *
 * For OAuth-authed MCP servers, mcp-proxy fronts both forms — it
 * injects per-user credentials at call time (Phase 3).
 */
const McpServerSchema = z.strictObject({
  transport: McpTransportSchema.optional(),
  /** HTTP/SSE MCP endpoint. Required for `http` and `sse`. Mutually exclusive with `ref` + `command`. */
  url: z.url().optional(),
  /** Guuey-hosted MCP server slug reference (e.g. `guuey://todoist`). Resolved at deploy time. */
  ref: z
    .string()
    .regex(/^guuey:\/\/[a-z0-9][a-z0-9-]{0,127}$/, 'must be `guuey://<slug>`')
    .optional(),
  /** Stdio executable. Required for `transport: 'stdio'`. Mutually exclusive with `url` + `ref`. */
  command: z.string().min(1).optional(),
  /** Stdio executable arguments. */
  args: z.array(z.string()).optional(),
  /** Static headers forwarded on every request. Values may use `${env.NAME}` placeholders. */
  headers: z.record(z.string().min(1), z.string()).optional(),
});

/**
 * Tool-gate block — allowlist applied first (intersect with what the MCP
 * server advertises), then denylist subtracts. Tool names are MCP-namespaced
 * (`"<server>.<tool>"`). Bare names match across all connected servers.
 */
const ToolGatesSchema = z.strictObject({
  allowlist: z.array(z.string().min(1)).optional(),
  denylist: z.array(z.string().min(1)).optional(),
});

/**
 * Runtime knobs the pod applies when constructing the framework adapter.
 * All optional with framework-chosen defaults.
 *
 * - `maxTurns`     — cap on agent loop turns per user message. Stops runaway
 *                    loops on misbehaving prompts. Default: framework default
 *                    (Claude SDK = 25).
 * - `temperature`  — model sampling temperature passthrough.
 */
const RuntimeConfigSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * Claude Agent SDK-specific knobs. Lives on a `framework` discriminator so
 * other adapters don't accidentally read fields they don't understand.
 */
const ClaudePermissionsSchema = z.strictObject({
  mode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
});

const ClaudeFrameworkConfigSchema = z.strictObject({
  permissions: ClaudePermissionsSchema.optional(),
});

/**
 * System prompt — string inline OR `{ file: 'prompts/system.md' }`.
 * File references are resolved relative to `guuey.json` by the loader,
 * which inlines the file contents into the snapshot before deploy upload.
 */
const SystemPromptSchema = z.union([
  z.string().min(1),
  z.strictObject({ file: z.string().min(1) }),
]);

/**
 * Bedrock-style invocation endpoint config.
 *
 * `kind: 'invoke'` exposes `POST /agent/invoke` with multi-modal input and
 * SSE response per `docs/plans/2026-05-25-platform-architecture.md` §6.
 * Reserved for future endpoint kinds (`'connect'` for WebSocket bidirectional).
 */
const EndpointConfigSchema = z.strictObject({
  kind: z.literal('invoke').optional(),
  streaming: z.boolean().optional(),
});

/**
 * Deploy config — pod size + region.
 *
 * Lives inside the `agent` section (was top-level on the pre-merge `guuey.json`).
 * Mirror shape on `guuey.mcp.json#mcpServer.deploy` (future) — same field set,
 * same semantics, just attached to a different artifact.
 *
 * Latent fields like `tier`, `maxPods`, `idleTimeoutMinutes` exist on the
 * AgentDeployment DDB model but are platform-managed (Reserved per design
 * doc §14.3) — not exposed in user-facing config.
 */
const DeploySchema = z.strictObject({
  /** Agent pod size. Canonical list lives in `./hosting.ts#AGENT_SIZES`. */
  size: z.enum(AGENT_SIZES).optional(),
  /** AWS region (e.g. `"us-east-1"`). Free-form; control plane enforces the live allow-list. */
  region: z.string().min(1).optional(),
});

/**
 * Auth posture for end-user invocations.
 *
 * - `'anonymous'` (default) — guest cookie minted on first invoke; persistent thread.
 * - `'required'`           — end-user must present a valid Cognito JWT; anonymous rejected.
 * - `'optional'`           — accept both; identity context reflects which.
 */
const AuthSchema = z.enum(['anonymous', 'required', 'optional']);

/**
 * Memory model. `'thread'` = automatic conversation history (DDB).
 * Semantic / vector memory deferred to a later schema version.
 */
const MemorySchema = z.enum(['thread', 'none']);

/**
 * VFS scopes to mount into the pod. Empty array = no VFS (still uses thread + state).
 */
const StorageScopeSchema = z.array(z.enum(['user', 'app']));

/**
 * The agent section — composes runtime + platform features + deploy.
 *
 * Exported as a zod object so the top-level `GuueyJsonV1` schema (in
 * `./schema.ts`) can nest it. Static type via {@link GuueyAgent}.
 */
export const AgentSectionV1 = z.strictObject({
  // ── Framework + runtime ──
  framework: z.enum(AGENT_FRAMEWORKS).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: SystemPromptSchema.optional(),
  /**
   * MCP servers the agent may call. **Replaces** the platform default
   * (`{ ggui: { url: 'https://mcp.ggui.ai' } }`) when present — not merged.
   * Omit the block to inherit the default; include `ggui` explicitly to
   * keep it alongside other servers.
   */
  mcpServers: z.record(z.string().min(1), McpServerSchema).optional(),
  tools: ToolGatesSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  /** Claude Agent SDK-specific knobs. Only read when `framework: 'claude-agent-sdk'`. */
  claude: ClaudeFrameworkConfigSchema.optional(),

  // ── Platform features (opt-in, sensible defaults) ──
  auth: AuthSchema.optional(),
  memory: MemorySchema.optional(),
  storage: StorageScopeSchema.optional(),

  // ── Env + secrets ──
  /** Literal non-sensitive env vars baked into the pod at boot. */
  env: z.record(z.string().min(1), z.string()).optional(),
  /**
   * Names (not values) of secrets the pod needs. Values are set via
   * `guuey secrets set NAME=...`, stored KMS-encrypted in DDB. Deploy-controller
   * resolves to values and injects as env vars at pod boot.
   */
  secrets: z.array(z.string().min(1)).optional(),

  // ── Invocation endpoint ──
  endpoint: EndpointConfigSchema.optional(),

  // ── Deploy ──
  deploy: DeploySchema.optional(),
});

/** Static TypeScript type derived from {@link AgentSectionV1}. */
export type GuueyAgent = z.infer<typeof AgentSectionV1>;

/** Single mcpServers entry type. */
export type GuueyAgentMcpServer = z.infer<typeof McpServerSchema>;

/** Tool-gate block type. */
export type GuueyAgentToolGates = z.infer<typeof ToolGatesSchema>;

/** Runtime-config block type. */
export type GuueyAgentRuntime = z.infer<typeof RuntimeConfigSchema>;

/** System-prompt shape (string or `{ file }`). */
export type GuueyAgentSystemPrompt = z.infer<typeof SystemPromptSchema>;

/** Endpoint config type. */
export type GuueyAgentEndpoint = z.infer<typeof EndpointConfigSchema>;

/** Deploy config type. */
export type GuueyAgentDeploy = z.infer<typeof DeploySchema>;

// ── No-literal-secrets validation (deploy-time contract enforcement) ──────────
//
// The schema (McpServerSchema JSDoc) requires secrets in `mcpServers[].headers`
// be referenced via `${env.NAME}` (declared in `agent.secrets`), never literal-
// inlined — otherwise the secret rides into the pod's `NOCODE_CONFIG_JSON` env
// var as plaintext (which the B6.3 secretKeyRef hardening cannot protect, since
// it's embedded in the config JSON, not a discrete env var). Nothing enforced
// this at deploy time; `validateNoLiteralSecrets` does.

/**
 * Header names that carry credentials. A value here that is a bare literal (no
 * `${env.NAME}` reference) is almost certainly a baked credential. Lowercased
 * for case-insensitive matching. Deliberately focused on unambiguous auth
 * headers — generic-shaped secrets in ANY header are caught separately by
 * {@link SECRET_SHAPE_PATTERNS} (so we don't false-positive on, e.g., `Cookie`).
 */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-authorization',
  'api-key',
  'api_key',
  'apikey',
]);

/**
 * Secret-shaped literal patterns — NAMED prefixes only, deliberately NOT
 * generic entropy/length heuristics (those false-positive on legit long IDs).
 * Applied to the header value AFTER stripping `${env.NAME}` references, so a
 * ref-based value like `Bearer ${env.TOKEN}` never trips them.
 */
const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /sk-ant-/, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/, // OpenAI-style sk- keys
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/, // Stripe secret keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temp access key id
  /\bghp_[A-Za-z0-9]{20,}/, // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}/, // GitHub OAuth
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/, // Slack
  /\bglpat-[A-Za-z0-9_-]{16,}/, // GitLab PAT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT (3 b64url segments)
];

/**
 * Is a header name credential-bearing? The explicit set plus low-false-positive
 * NAME signals (a custom `X-Auth-*` / `*-secret` / `*-password` header is almost
 * certainly a credential). Deliberately NOT bare `key`/`token` (benign uses:
 * `Idempotency-Key`, `X-Request-Token`). Fully-opaque secrets in an
 * arbitrarily-named header still slip layer 2 — that's undetectable without
 * false-positives, so it stays best-effort (a lint, not a guarantee).
 */
function isSensitiveHeaderName(name: string): boolean {
  const n = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(n)) return true;
  if (/(^|[-_])auth(orization)?([-_]|$)/.test(n)) return true; // x-auth-*, *-auth-token
  if (/(^|[-_])api[-_]?key([-_]|$)/.test(n)) return true; // x-api-key variants
  return /(secret|credential|password|passwd)/.test(n);
}

/** Non-secret auth scheme words that may legitimately stand before an `${env.NAME}` ref. */
const AUTH_SCHEME_WORDS = /\b(bearer|basic|token|digest|negotiate)\b/gi;

const ENV_REF_GLOBAL = /\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}/g;
const HAS_ENV_REF = /\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Validate that no `mcpServers[*].headers` value carries a LITERAL secret.
 * Returns a list of human-readable violation messages (empty = clean).
 *
 * Two layers:
 *  1. Strip `${env.NAME}` refs from each value, then match the literal
 *     remainder against {@link SECRET_SHAPE_PATTERNS} → a baked secret in ANY
 *     header (e.g. `Authorization: Bearer sk-ant-...`).
 *  2. For {@link SENSITIVE_HEADER_NAMES}, a value with NO `${env.NAME}` ref and
 *     a non-trivial literal (after removing scheme words) → a baked credential
 *     (e.g. `X-API-Key: abc123`, `Authorization: Basic <base64>`).
 *
 * Legit ref-based values (`Authorization: Bearer ${env.TOKEN}`,
 * `X-API-Key: ${env.KEY}`) and non-secret literals (`Content-Type`) pass.
 */
export function validateNoLiteralSecrets(
  agent: GuueyAgent | undefined,
): string[] {
  const violations: string[] = [];
  const servers = agent?.mcpServers;
  if (!servers) return violations;

  for (const [serverName, server] of Object.entries(servers)) {
    const headers = server?.headers;
    if (!headers) continue;
    for (const [headerName, rawValue] of Object.entries(headers)) {
      const value = String(rawValue);
      const literalRemainder = value.replace(ENV_REF_GLOBAL, '');

      // (1) secret-shaped literal anywhere in the non-ref text.
      if (SECRET_SHAPE_PATTERNS.some((re) => re.test(literalRemainder))) {
        violations.push(
          `mcpServers.${serverName}.headers.${headerName}: contains a literal secret — reference it as \${env.NAME} and declare the name in agent.secrets`,
        );
        continue;
      }

      // (2) sensitive header with a fully-literal (no-ref) credential value.
      if (isSensitiveHeaderName(headerName) && !HAS_ENV_REF.test(value)) {
        const bare = literalRemainder.replace(AUTH_SCHEME_WORDS, '').trim();
        if (bare.length > 0) {
          violations.push(
            `mcpServers.${serverName}.headers.${headerName}: sensitive header must reference a secret as \${env.NAME} (declared in agent.secrets), not a literal value`,
          );
        }
      }
    }
  }
  return violations;
}

/**
 * Platform default MCP server map. Applied by the pod when `agent.mcpServers`
 * is absent. Exposed here so non-pod consumers (CLI dry-run, lints) can show
 * the effective shape without duplicating the literal.
 */
export const DEFAULT_AGENT_MCP_SERVERS: Record<string, GuueyAgentMcpServer> = {
  ggui: { url: 'https://mcp.ggui.ai', transport: 'http' },
};
