/**
 * `agent.json` v1 — the declarative agent definition.
 *
 * Sibling file to `guuey.json` (hosted-deploy overlay) and `ggui.json`
 * (portable ggui-app identity). `agent.json` is the **agent definition**:
 * the prompt, the model, the framework adapter, the MCP servers the agent
 * may call, and the tool gates. The stock guuey nocode-runtime pod reads
 * this document at boot and configures the framework adapter from it —
 * no agent code required.
 *
 * Three-file model:
 *
 * - `guuey.json`  — hosted overlay (project id, deploy size/region, managed
 *                   MCP proxies). Schema lives in this same package.
 * - `ggui.json`   — open ggui-app identity (slug, gadgets, publicEnv).
 *                   Schema owned by `@ggui-ai/project-config`.
 * - `agent.json`  — declarative agent definition (this file). Schema lives
 *                   in this same package because it's read by Guuey's
 *                   closed pod runtime + closed CLI, not by the open SDK.
 *
 * A repo can ship any subset:
 *
 * - `agent.json` alone   → no-code declarative agent, deploys via
 *                          `guuey deploy --config agent.json`, runs on
 *                          stock nocode-runtime pod.
 * - `agent.json` + `Dockerfile` → declarative shape + a code-mode build.
 *                          The Dockerfile path wins; agent.json is metadata.
 * - `Dockerfile` alone   → fully code-mode; agent.json is not required.
 *
 * **Minimal valid document** (the most common shape for launch agents):
 *
 * ```json
 * { "schema": "1", "systemPrompt": { "file": "prompts/system.md" } }
 * ```
 *
 * Defaults applied by the pod runtime when fields are absent:
 * - `framework`   → `'claude-agent-sdk'`
 * - `mcpServers`  → `{ ggui: { url: 'https://mcp.ggui.ai' } }` (the
 *                    platform default; explicitly declaring `mcpServers`
 *                    REPLACES the default — it is not merged).
 * - `model`       → framework-chosen default (Claude SDK currently picks
 *                    `claude-sonnet-4-6`).
 * - `systemPrompt`→ `GUUEY_DEFAULT_SYSTEM_PROMPT` from `./system-prompt`.
 *
 * **Rules for extending:**
 *
 * 1. **Additive only within `schema: '1'`.** New optional fields are safe.
 * 2. **Framework-neutral by default.** Fields that are meaningful to only
 *    one adapter (e.g. Claude's `permissions`, OpenAI's `tools.functions`)
 *    belong on a `framework`-scoped sub-block, not at the top level.
 * 3. **No hosted-overlay fields.** Anything Guuey-specific (region, size,
 *    workspace id) belongs in `guuey.json`. Anything ggui-app-specific
 *    (slug, gadgets) belongs in `ggui.json`.
 */
import { z } from 'zod';

/**
 * Supported framework adapters. The pod runtime selects the matching
 * adapter at boot. `vanilla` skips the framework layer entirely — the
 * agent loop is the bare Anthropic Messages API call with manual MCP
 * tool wiring. Useful for benchmarking and for adapters not yet
 * built.
 *
 * Tuple so we can derive both the zod enum and the static type from
 * one source.
 */
export const AGENT_FRAMEWORKS = [
  'claude-agent-sdk',
  'openai',
  'google-adk',
  'vanilla',
] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

/**
 * MCP server transport. Stock pod ships with `http` and `sse` support
 * out of the box — those are the URL-based transports the nocode
 * runtime can dial without extra code. `stdio` is reserved for code-
 * mode agents that ship their own MCP binaries in the Dockerfile; the
 * nocode runtime rejects `stdio` entries at validation time because
 * it has no way to spawn the child process safely under gVisor.
 */
const McpTransportSchema = z.enum(['http', 'sse', 'stdio']);

/**
 * A single MCP server entry. `url` is required for `http`/`sse`;
 * `command` + `args` are required for `stdio`. The schema can't
 * cross-validate that cleanly without a discriminated union (which
 * makes JSON authoring awkward), so we keep the structural shape
 * loose and validate the mode-specific fields at pod boot.
 *
 * `headers` is forwarded to the MCP server on every request — used
 * for static API keys, project pins, etc. Secrets should NEVER be
 * inlined here; reference them as `${env.NAME}` and let the pod's
 * env-substitution pass fill them from the deploy env block.
 */
const McpServerSchema = z.strictObject({
  /** Transport. Default: `http` when only `url` is set. */
  transport: McpTransportSchema.optional(),
  /** HTTP/SSE MCP endpoint. Required for `http` and `sse`. */
  url: z.url().optional(),
  /** Stdio executable. Required for `transport: 'stdio'`. */
  command: z.string().min(1).optional(),
  /** Stdio executable arguments. */
  args: z.array(z.string()).optional(),
  /**
   * Static headers forwarded on every request. Values may use
   * `${env.NAME}` placeholders — the pod substitutes from its deploy
   * env at boot. Secrets are never inlined in the literal value.
   */
  headers: z.record(z.string().min(1), z.string()).optional(),
});

/**
 * Tool-gate block. Both lists are optional and additive — the pod
 * applies allowlist first (intersect with tools the MCP server
 * advertises) then denylist (subtract from the result).
 *
 * Tool names are MCP-namespaced: `"<server>.<tool>"` (e.g.
 * `"ggui.suggest_ui"`). A bare tool name (no server prefix) matches
 * the tool across every connected server — useful for catch-all
 * denies like `"shell"` but should be used sparingly.
 */
const ToolGatesSchema = z.strictObject({
  /**
   * If present + non-empty, only listed tools are exposed to the model.
   * Absent or empty array = no allowlist gating (every advertised tool
   * is exposed before denylist runs).
   */
  allowlist: z.array(z.string().min(1)).optional(),
  /**
   * Tools to strip even if they would otherwise pass the allowlist.
   * Always wins over `allowlist`.
   */
  denylist: z.array(z.string().min(1)).optional(),
});

/**
 * Runtime knobs the pod applies when constructing the framework
 * adapter. All optional with framework-chosen defaults.
 *
 * - `maxTurns`     — cap on agent loop turns per user message. Stops
 *                    runaway loops on misbehaving prompts. Default:
 *                    framework default (Claude SDK = 25).
 * - `env`          — static env vars exposed to the agent process at
 *                    boot. Use for non-secret config; secrets flow
 *                    through Guuey's deploy env (set via
 *                    `guuey env set NAME=...`), not via this block.
 * - `temperature`  — model sampling temperature passthrough. Most
 *                    agents leave this at framework default.
 */
const RuntimeConfigSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(200).optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * Claude Agent SDK-specific knobs. Lives on a `framework` discriminator
 * so other adapters don't accidentally read fields they don't
 * understand. Currently the only adapter-scoped block; OpenAI and
 * Google ADK blocks land additively when their adapter ships.
 */
const ClaudePermissionsSchema = z.strictObject({
  /**
   * Permission mode for the Claude Agent SDK loop. `'default'` is the
   * SDK default (prompt for sensitive ops); `'acceptEdits'` auto-
   * approves file edits; `'bypassPermissions'` skips the prompt
   * machinery entirely. The pod refuses `bypassPermissions` on
   * production deploys — Guuey-side enforcement, not schema-level.
   */
  mode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional(),
});

const ClaudeFrameworkConfigSchema = z.strictObject({
  permissions: ClaudePermissionsSchema.optional(),
});

/**
 * System prompt. Two shapes for ergonomics:
 *
 * - `string` — inline. Good for one-liners and for prompts that
 *              don't merit a separate file.
 * - `{ file: 'prompts/system.md' }` — file reference resolved
 *              relative to `agent.json`. The loader inlines the
 *              file contents when called via {@link loadAgentJson}
 *              so the pod sees only resolved strings.
 *
 * Multiple file references (`files: [...]`) is intentionally NOT
 * supported in v1 — single-source-of-truth for the prompt simplifies
 * audit and replay. Compose by reading the file and assembling
 * server-side if needed.
 */
const SystemPromptSchema = z.union([
  z.string().min(1),
  z.strictObject({
    file: z.string().min(1),
  }),
]);

/**
 * The authoritative v1 schema.
 *
 * `model` is free-form — the framework adapter validates the literal
 * against its own supported set at boot. Pinning a model enum here
 * would force a schema bump every time Anthropic ships a new model.
 */
export const AgentJsonV1 = z.strictObject({
  schema: z.literal('1'),
  framework: z.enum(AGENT_FRAMEWORKS).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: SystemPromptSchema.optional(),
  /**
   * MCP servers the agent may call. **Replaces** the platform default
   * (`{ ggui: { url: 'https://mcp.ggui.ai' } }`) when present — not
   * merged. Omit the block to inherit the default; include `ggui`
   * explicitly if you want it alongside other servers.
   */
  mcpServers: z.record(z.string().min(1), McpServerSchema).optional(),
  tools: ToolGatesSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  /**
   * Claude Agent SDK-specific knobs. Only read when
   * `framework: 'claude-agent-sdk'` (or absent — Claude is default).
   */
  claude: ClaudeFrameworkConfigSchema.optional(),
});

/** Static TypeScript type derived from the v1 schema. */
export type AgentJsonV1 = z.infer<typeof AgentJsonV1>;

/** Single mcpServers entry type. */
export type AgentJsonMcpServer = z.infer<typeof McpServerSchema>;

/** Tool-gate block type. */
export type AgentJsonToolGates = z.infer<typeof ToolGatesSchema>;

/** Runtime-config block type. */
export type AgentJsonRuntime = z.infer<typeof RuntimeConfigSchema>;

/** System-prompt shape (string or `{ file }`). */
export type AgentJsonSystemPrompt = z.infer<typeof SystemPromptSchema>;

/**
 * Canonical filename — always at the project root, always this name.
 * Exported so tooling uses the same constant instead of hard-coding
 * the string.
 */
export const AGENT_JSON_FILENAME = 'agent.json';

/**
 * Platform default MCP server map. Applied by the pod when
 * `agent.json#mcpServers` is absent. Exposed here so non-pod consumers
 * (CLI dry-run, lints) can show the effective shape without
 * duplicating the literal.
 */
export const DEFAULT_AGENT_MCP_SERVERS: Record<string, AgentJsonMcpServer> = {
  ggui: { url: 'https://mcp.ggui.ai', transport: 'http' },
};

/**
 * Parse a raw JSON value into a validated {@link AgentJsonV1}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Does NOT resolve `systemPrompt.file` references — that's the
 * loader's job (see {@link loadAgentJson} in `./agent-loader.ts`).
 * Pure parse is safe to run anywhere; file resolution requires a
 * base directory and is Node-only.
 */
export function parseAgentJson(raw: unknown): AgentJsonV1 {
  return AgentJsonV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result.
 * Prefer this inside CLI tooling where you want to render the issue
 * list without try/catch.
 */
export function safeParseAgentJson(
  raw: unknown,
): ReturnType<typeof AgentJsonV1.safeParse> {
  return AgentJsonV1.safeParse(raw);
}
