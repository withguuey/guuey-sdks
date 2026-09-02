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
 *   "model": "claude-sonnet-5",
 *   "systemPrompt": { "file": "prompts/system.md" }
 * }
 * ```
 *
 * Defaults applied by the pod runtime when fields are absent:
 * - `framework`   → `'claude-agent-sdk'`
 * - `mcpServers`  → `{ ggui: { url: 'https://mcp.ggui.ai' } }` (platform default; declaring `mcpServers` MERGES ON TOP of this (guuey#24 option A); opt out with `ggui: false`)
 * - `model`       → framework-chosen default (Claude SDK → `claude-sonnet-5`)
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
import { isValidColocatedServerName } from './colocated.js';

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
 * Static header map — forwarded on every request. Values may use `${env.NAME}`
 * placeholders; the pod's env-substitution pass fills them at call time.
 * Secrets MUST be referenced via `${env.NAME}` and declared in `agent.secrets`.
 */
const HeadersSchema = z.record(z.string().min(1), z.string());

/**
 * Cross-app profile access posture. `'read'` = the agent may recall the
 * user's cross-app profile; `'read-write'` additionally lets it write this
 * app's section. Absent = no profile access (default-closed, consent-gated).
 */
export const ProfileAccessSchema = z.enum(['read', 'read-write']);
/** Static TypeScript type derived from {@link ProfileAccessSchema}. */
export type ProfileAccess = z.infer<typeof ProfileAccessSchema>;

/**
 * `kind: 'colocated'` — MCP server runs as a guuey-managed HTTP child
 * **inside the agent pod** (co-locate = same gVisor sandbox). COGS: ~$0
 * (rides the agent pod). `source` is a project-relative path the Router
 * lowering builds/boots as a local HTTP server; `devPort` mirrors the
 * `hosted`/`external` dev-loop story (name→localhost URL resolution for
 * `guuey dev`).
 */
const ColocatedMcp = z.strictObject({
  kind: z.literal('colocated'),
  /** Source directory relative to `guuey.json`. Required. */
  source: z.string().min(1),
  /** Local dev-loop port (`guuey dev`) this MCP is served on for name→localhost URL resolution. */
  devPort: z.number().int().min(1).max(65535).optional(),
});

/**
 * `kind: 'hosted'` — a workspace-owned registry MCP running on guuey's
 * `mcp-servers.guuey.com` fleet (Starter+). At least one of `server` or `source`
 * must be set:
 *
 * - `server: '<id>'` — reuse an existing registry MCP by id.
 * - `source: './path'` — build-or-reuse by workspace-unique name; the
 *   deploy-controller resolves to a `server` id and writes it back — WITHOUT
 *   removing `source`, so both are legitimately present after a `guuey deploy`
 *   (`server` wins at resolve time; `source` remains the build recipe).
 */
const HostedMcp = z
  .strictObject({
    kind: z.literal('hosted'),
    /** Existing registry MCP id. May coexist with `source` post-deploy write-back. */
    server: z.string().min(1).optional(),
    /** Source directory relative to `guuey.json`. May coexist with `server` post-deploy write-back. */
    source: z.string().min(1).optional(),
    /** Local dev-loop port (`guuey dev`) this MCP is served on for name→localhost URL resolution. */
    devPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((v) => v.server != null || v.source != null, {
    message: 'hosted MCP needs `server`and/or`source`',
  });

/**
 * `kind: 'external'` — any MCP reached by URL: builder-hosted, or a
 * third-party SaaS server (Linear, Notion, GitHub, …).
 *
 * One map, three credential sources + one forward (guuey#178 D1):
 * - `transport` defaults to `'http'` (StreamableHTTP).
 * - static `headers` (values may use `${env.NAME}`) — API-key servers.
 * - `federate: true` makes guuey mint a per-invoke JWT with `aud = url` that
 *   the builder's MCP validates against the guuey JWKS.
 * - `credential: 'oauth'` — the server's users sign in with the server's OWN
 *   OAuth authorization server; guuey brokers the dance and the token
 *   (see the field doc). URL + `credential: 'oauth'` is the whole
 *   declaration — nothing is builder-registered; discovery does the rest.
 * - `credential: 'caller'` forwards the invoke's own byo-verified bearer as
 *   this server's per-turn credential (guuey#179) — see the field doc.
 * - `authMode: 'upfront'` (only beside `credential: 'oauth'`, guuey#605)
 *   fronts the sign-in: the consent card surfaces at session start instead
 *   of on demand — see the field doc for the exact engagement contract.
 */
const ExternalMcp = z
  .strictObject({
    kind: z.literal('external'),
    /** Full HTTP/SSE base URL. */
    url: z.url(),
    /** Transport protocol. Defaults to `'http'` (StreamableHTTP). */
    transport: z.enum(['http', 'sse']).optional(),
    /**
     * Mint a per-invoke `aud = url` JWT and inject it as `Authorization: Bearer`.
     * The builder's MCP verifies it against the guuey JWKS (T6b).
     */
    federate: z.boolean().optional(),
    /**
     * `'caller'` — the third credential source (guuey#179, beside static
     * `headers` and `federate`): per invoke, the pod forwards the request's OWN
     * VERIFIED `Authorization` bearer as this server's credential. Only a bearer
     * verified by the app's BYO IdP (`userAuthMode: 'byo'`) is ever forwarded —
     * a guuey-native Cognito token is never eligible, so a builder cannot use
     * this mode to harvest platform tokens. Fail-closed: an invoke with no
     * byo-verified bearer writes no credential file and that server's calls
     * fail loudly. Caller-opt-in by construction (the embedding client chooses
     * which app receives its token); FIRST-PARTY USE ONLY for now — gate this
     * (URL allowlist or console warning) before opening it to arbitrary
     * builders. Mutually exclusive with `federate: true`.
     *
     * `'oauth'` — the FOURTH mode (guuey#178): the server is a third-party
     * MCP whose end users must sign in with the server's own OAuth
     * authorization server (RFC 9728 / 8414 discovery, PKCE, RFC 8707
     * resource). guuey runs the dance ONCE per (user, server) from a
     * consent card in the chat, seals the token in the platform's
     * credential broker, and the agent's calls to this server go through
     * the broker's gateway (`https://mcp.<apex>/brokered/<appId>/<name>/`),
     * which injects the user's token per call — the agent pod never holds
     * the third-party token. The deploy-controller lowers this entry by
     * setting {@link mcpResourceUrl} to that route while `url` keeps the
     * upstream. Deploy-only: `guuey dev` has no lowered snapshot. Mutually
     * exclusive with `federate: true` (the broker route IS the federation
     * target) and with a declared `authorization` header (the broker
     * injects the only Authorization this server ever sees).
     */
    credential: z.enum(['caller', 'oauth']).optional(),
    /**
     * `'upfront'` — require sign-in BEFORE use (guuey#605, the claude.ai
     * "Always required" parity flavor). Valid ONLY beside
     * `credential: 'oauth'` (schema-refused otherwise — no other credential
     * mode has a sign-in to front-load).
     *
     * WHEN IT ENGAGES: at SESSION START of auth-mode (authenticated-caller)
     * sessions, on an agent-runtime image carrying the guuey#605 pod half —
     * an upfront server with no live connection surfaces the OAuth consent
     * card as the turn's ONLY content (the pod holds the turn; no agent
     * answer) until the user connects the account, instead of appending the
     * card after the agent's first tool-less turn. Unchanged postures:
     * guests (D6 — no card, no credential, tool-less), an explicit `denied`
     * grant (no card, tool-less — a "no" never bricks the chat), a failed /
     * slow preflight (fail-open tool-less turn, never held), and a client
     * that cannot render the consent card (falls back to on-demand consent
     * — an embed never dead-ends on a card it cannot show). Absent =
     * today's on-demand behavior everywhere: connect anonymous-first, the
     * consent card rides after the agent's turn.
     *
     * SERVING (the guuey#566 Settings-truth rule — this doc is the exact
     * engagement contract): NO environment honors this field until infra
     * rolls the agent-runtime image carrying the guuey#605 pod half — as of
     * this schema's cut, dev, staging and release all serve pre-roll images
     * that do not. A pod PREDATING the roll refuses a snapshot carrying the
     * field at config parse (strict schema — not parse-and-ignore), so the
     * platform must not accept it at the deploy door until the rolled image
     * serves that environment. The oss cohort cut carries this schema bump;
     * the image roll arms serving.
     */
    authMode: z.literal('upfront').optional(),
    /** Static headers forwarded on every request. Values may use `${env.NAME}` placeholders. */
    headers: HeadersSchema.optional(),
    /** Local dev-loop port (`guuey dev`) this MCP is served on for name→localhost URL resolution. */
    devPort: z.number().int().min(1).max(65535).optional(),
    /**
     * INTERNAL — set only by Router lowering; when present the federation mint
     * uses this as the RFC 8707 resource instead of `url`.
     */
    mcpResourceUrl: z.url().optional(),
    /**
     * INTERNAL — set only by Router lowering when this entry is the spliced
     * profile MCP; carries the agent's `profileAccess` posture onto the entry
     * itself so the profile child's tool gate (read vs read-write) survives
     * independent of the top-level `agent.profileAccess` field.
     */
    profileAccess: ProfileAccessSchema.optional(),
  })
  .refine((v) => !(v.credential === 'caller' && v.federate === true), {
    message:
      "credential: 'caller' cannot be combined with federate: true — the forwarded caller bearer IS the credential; a minted federation token would shadow it",
  })
  .refine((v) => !(v.credential === 'oauth' && v.federate === true), {
    message:
      "credential: 'oauth' cannot be combined with federate: true — the brokered gateway route IS this server's federation target; the pod mints for it automatically",
  })
  .refine(
    (v) =>
      !(
        v.credential === 'oauth' &&
        Object.keys(v.headers ?? {}).some((h) => h.toLowerCase() === 'authorization')
      ),
    {
      message:
        "credential: 'oauth' cannot be combined with an `authorization` header — the credential broker injects the user's OAuth token as the only Authorization this server sees",
    },
  )
  .refine((v) => !(v.authMode === 'upfront' && v.credential !== 'oauth'), {
    message:
      "authMode: 'upfront' is only valid beside credential: 'oauth' — upfront sign-in fronts the OAuth broker's consent flow; no other credential mode has a sign-in to front-load",
  });

/**
 * A single MCP server entry inside `agent.mcpServers`.
 *
 * Discriminated union on `kind` — one slot per hosting mode:
 * - `colocated` — guuey-managed HTTP child inside the agent pod
 * - `hosted`    — guuey-hosted registry MCP (Starter+)
 * - `external`  — reached by URL: builder-hosted (plain / federated /
 *                 caller-forwarded) or third-party OAuth (`credential: 'oauth'`)
 *
 * (`kind: 'proxied'` — the pre-registration placeholder the mcp-proxy broker
 * once reserved — is gone: `credential: 'oauth'` on an `external` entry IS
 * that arm, guuey#178 D1.)
 */
const McpServerSchema = z.discriminatedUnion('kind', [
  ColocatedMcp,
  HostedMcp,
  ExternalMcp,
]);

/**
 * One declared `mcpServers` VALUE: a real server entry, or the literal `false`
 * — the generative-UI opt-out, valid ONLY under the `ggui` key (enforced by
 * the agent-level refine; the subtree schema stays lenient by design).
 */
export const McpServerEntrySchema = z.union([McpServerSchema, z.literal(false)]);
export type DeclaredMcpServers = Record<string, GuueyAgentMcpServer | false>;

/**
 * Tool-gate block — `allowlist` first (the model may call ONLY these), then
 * `denylist` subtracts (removed from the model's catalog outright). Both
 * optional; both empty/absent → every tool of every connected server.
 *
 * Entry shapes (guuey#234 — the ONE grammar, parsed by
 * {@link parseToolGateEntry}, validated at deploy time by
 * {@link validateToolGates}, and translated to the framework's own tool
 * names by the host at turn time):
 *
 * - `"<server>.<tool>"` — one tool of one declared MCP server
 *   (`"todoist.create_task"`).
 * - `"<server>.*"`      — every tool of one declared server (`"ggui.*"`).
 * - `"<tool>"`          — a bare name: that tool on EVERY connected server
 *   (`"search"`), and — for a Claude agent on a GuueyFS-armed pod — the
 *   built-in file tool of that name (`"Bash"`, `"Write"`, …).
 *
 * `<server>` must name a server this agent connects: a declared
 * `mcpServers` key, the platform default `ggui` (unless opted out with
 * `ggui: false`), or a platform-injected reserved server
 * ({@link RESERVED_MCP_SERVER_NAMES}). The framework-internal spellings
 * (`mcp__server__tool`) are NOT accepted — write the config grammar and
 * let the host translate.
 *
 * Runtime posture (Claude): a tool the model picks that is NOT in an explicit
 * allowlist is DENIED with a message the model can read — never routed to an
 * interactive prompt (a headless pod has no one to answer one). Deny-listed
 * tools never reach the model's catalog at all.
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
 * One mode of a multi-mode agent (guuey#527). `systemPromptAppend` extends
 * the base prompt (inline string or a `{ file }` the loader inlines);
 * `systemPrompt` replaces it wholesale — exactly ONE of the two (the
 * refine on {@link ModesSchema} enforces the xor). `tools.allowlist`, when
 * present, must be a subset of the base allowlist — the WRITE GATE enforces
 * that (the schema can't see the base), so a mode only ever narrows.
 * `audience` is accepted for forward-compat but the SERVER hardcodes the
 * binding for the recognized pair in tonight's slice.
 */
const ModeSchema = z.strictObject({
  systemPromptAppend: SystemPromptSchema.optional(),
  systemPrompt: SystemPromptSchema.optional(),
  tools: ToolGatesSchema.optional(),
  audience: z.array(z.enum(['guest', 'authenticated', 'byo'])).optional(),
});

/**
 * The `agent.modes` map (guuey#527). Mode keys are short machine
 * identifiers (`rep`, `agent`, …) — the court-key grammar, reused. Each
 * value is a {@link ModeSchema}; a mode declares AT MOST one of
 * `systemPromptAppend` / `systemPrompt` (both = a contradiction the
 * manifest must not carry).
 */
const MODE_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ModesSchema = z
  .record(z.string().regex(MODE_KEY_RE), ModeSchema)
  .refine(
    (modes) =>
      Object.values(modes).every(
        (m) => !(m.systemPromptAppend !== undefined && m.systemPrompt !== undefined),
      ),
    { message: 'a mode declares at most one of systemPromptAppend / systemPrompt, never both' },
  );

/**
 * Does the BASE tool allowlist permit `entry`? (guuey#527 subset rule.)
 * A base pattern covers `entry` when it is `*`, an exact match, or a
 * `prefix.*` wildcard whose prefix `entry` falls under. This is the SAME
 * coverage semantics the pod's gate applies at call time, so "the mode's
 * allowlist is a subset" means exactly "every mode tool the base already
 * permits" — a mode can only ever NARROW, never widen.
 */
export function baseAllowlistPermits(
  baseAllowlist: readonly string[] | undefined,
  entry: string,
): boolean {
  // No base allowlist = the model may call anything, so any mode entry is
  // trivially permitted (the mode is still a real narrowing of "anything").
  if (baseAllowlist === undefined) return true;
  return baseAllowlist.some((b) => {
    if (b === '*') return true;
    if (b === entry) return true;
    if (b.endsWith('.*')) {
      const prefix = b.slice(0, -1); // keep the dot: "platform." covers "platform.whoami"
      return entry.startsWith(prefix);
    }
    return false;
  });
}

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
 * - `'required'`           — end-user must present a verified credential (guuey Cognito
 *                            JWT, or the app's configured BYO issuer); the pod refuses
 *                            an anonymous invoke pre-model with HTTP 403 `AUTH_REQUIRED`
 *                            (guuey#181). Independent of the app record's `guestAccess`
 *                            runtime override — either gate can refuse.
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
 * Absent = the platform default `['user', 'app']`. Consumed by
 * {@link agentDeclaresVfs} — the per-AGENT half of the runtime's `fsBound`
 * signal (guuey#234): a `storage: []` agent gets NO built-in file tools even on
 * a GuueyFS-armed pod.
 */
const StorageScopeSchema = z.array(z.enum(['user', 'app']));

/**
 * Whether the agent wants VFS layers at all (guuey#234). `storage` absent →
 * the platform default (`['user','app']`) → true; `storage: []` → false; any
 * non-empty list → true. The runtime ANDs this with the pod's own GuueyFS
 * arming to decide `Invoke.fsBound` (→ built-in file tools + `Bash`), so an
 * agent whose definition says "no VFS" never carries a catalog wider than its
 * definition, whatever the pod is capable of.
 */
export function agentDeclaresVfs(agent: { storage?: ReadonlyArray<'user' | 'app'> } | undefined): boolean {
  const storage = agent?.storage;
  return storage === undefined || storage.length > 0;
}

/**
 * The agent section — composes runtime + platform features + deploy.
 *
 * Exported as a zod object so the top-level `GuueyJsonV1` schema (in
 * `./schema.ts`) can nest it. Static type via {@link GuueyAgent}.
 */
/**
 * The `agent.mcpServers` map alone — for consumers that resolve/lower the
 * servers SUBTREE without validating the whole snapshot (deploy-controller's
 * resolve-mcp): whole-snapshot strictness made lowering fail open on any
 * schema field the running consumer predates.
 */
export const McpServersSection = z.record(z.string().min(1), McpServerEntrySchema);

export const AgentSectionV1 = z.strictObject({
  // ── Deploy routing ──
  /**
   * Routing declaration for `guuey deploy`:
   *
   * - `'code'` — a worker-entry project: the CLI runs the package build
   *   (`corepack pnpm build` → `guuey.worker.js`), packs the project root,
   *   and the platform builds the runtime image from its own base image
   *   (code-mode `AgentDeployment`). Stamped by `@guuey/create-agentic-app`
   *   scaffolds so they route explicitly.
   * - `'declarative'` — no source to build; the CLI POSTs the guuey.json
   *   snapshot directly (nocode `AgentDeployment`, stock runtime pod).
   * - absent — the platform infers: declarative when the project has no
   *   Dockerfile (a root Dockerfile keeps the legacy user-image code path).
   */
  mode: z.enum(['code', 'declarative']).optional(),

  // ── Framework + runtime ──
  framework: z.enum(AGENT_FRAMEWORKS).optional(),
  /**
   * Graceful code-mode: a module (path relative to the project root, built
   * output) whose default export is the framework-native agent object or a
   * factory `(guuey: GuueyContext) => agent`. The platform host imports and
   * runs it — the dev writes zero harness code. Mutually exclusive with the
   * full-worker `worker` field (which wins when both are present).
   */
  entry: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /**
   * Managed-LLM provider selector — only meaningful for
   * `framework: 'openai-agents-sdk'`, where OpenAI and OpenRouter share the
   * identical OpenAI wire and the Router must pick the upstream + platform key
   * at invoke time. `'openrouter'` routes managed traffic to OpenRouter;
   * absent or `'openai'` uses native OpenAI. Ignored for other frameworks
   * (claude → Anthropic, google-adk → Gemini are framework-determined).
   */
  modelProvider: z.enum(['openai', 'openrouter']).optional(),
  systemPrompt: SystemPromptSchema.optional(),
  /**
   * MCP servers the agent may call. **Merges on top of** the platform default
   * (`{ ggui: { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http' } }`,
   * guuey#24 option A) — see {@link effectiveMcpServers}. Omit the block to
   * inherit the default unchanged; declare `ggui` explicitly to override it;
   * declare `ggui: false` to opt out of it entirely.
   *
   * Each entry is a discriminated union on `kind`, or the literal `false`
   * (valid only under the `ggui` key):
   * - `'colocated'` — guuey-managed HTTP child inside the agent pod
   * - `'hosted'`    — guuey-hosted registry MCP (Starter+)
   * - `'external'`  — reached by URL (plain / federated / caller-forwarded /
   *                   third-party OAuth via `credential: 'oauth'`)
   */
  mcpServers: z
    .record(z.string().min(1), McpServerEntrySchema)
    .superRefine((servers, ctx) => {
      for (const [name, entry] of Object.entries(servers)) {
        if (entry === false && name !== 'ggui') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `mcpServers.${name}: false is only valid for the "ggui" key (it opts out of the platform-default generative-UI server) — remove the "${name}" entry instead`,
          });
        }
      }
    })
    .optional(),
  tools: ToolGatesSchema.optional(),
  /**
   * Multi-mode agent (guuey#527) — ONE agent, per-mode prompt overlays on
   * the base `systemPrompt` + a per-mode tool SUBSET of the base allowlist.
   * THE AXIS (founder-refined 2026-08-31, the final word): modes are the
   * AUDIENCE'S AUTH STATE — v1 recognizes exactly `guest` (website
   * visitors; the hire-a-rep mode) and `auth` (signed-in users; navigated
   * separately in studio). SELECTION is SERVER-DERIVED from the caller's
   * REAL auth state ({@link applyAgentMode}) — an anonymous caller
   * structurally cannot claim auth mode; the widget/SDK `mode` param is a
   * PIN within permission (authed may pin `guest` to preview-as-visitor;
   * a guest pinning `auth` clamps). `defaultMode` and per-mode `audience`
   * are v1-DEPRECATED (parseable, not consulted — derivation replaced
   * both); the grammar stays key-agnostic for future axes.
   *
   * Each mode: exactly one of `systemPromptAppend` (extend the base — the
   * common case) or `systemPrompt` (full replace); an optional `tools`
   * allowlist that must be a SUBSET of the base `agent.tools.allowlist`
   * (the write gate enforces it — a mode can only ever NARROW).
   */
  modes: ModesSchema.optional(),
  /** The mode a caller with no audience match resolves to (a declared mode key). */
  defaultMode: z.string().min(1).optional(),
  /**
   * The platform wrapper's SURFACE-FORMATTING section (guuey#531) —
   * default ON, opt-out only: a few invoke-constant lines telling the
   * model that guuey's chat surfaces render markdown (code fences +
   * inline code, autolinked bare URLs, native tables), so every builder
   * doesn't have to discover that independently. Set `false` for BYO
   * surfaces (`@guuey/agent-client` custom clients — SMS/voice/
   * plain-text) where markdown is not the contract. The exact text
   * lives at `@guuey/host` `SURFACE_FORMATTING_SECTION` and is
   * published verbatim in the docs — never tone/brand/behavior.
   */
  surfaceHints: z.boolean().optional(),
  runtime: RuntimeConfigSchema.optional(),
  /** Claude Agent SDK-specific knobs. Only read when `framework: 'claude-agent-sdk'`. */
  claude: ClaudeFrameworkConfigSchema.optional(),

  // ── Platform features (opt-in, sensible defaults) ──
  auth: AuthSchema.optional(),
  memory: MemorySchema.optional(),
  storage: StorageScopeSchema.optional(),
  profileAccess: ProfileAccessSchema.optional(),

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
}).superRefine((agent, ctx) => {
  // guuey#527 — the mode tool SUBSET rule, enforced at parse time (CLI
  // loader AND server both run this): a mode's tool allowlist may only
  // contain tools the BASE allowlist already permits. A mode narrows,
  // never widens — the one privilege-adjacent axis, closed here.
  if (agent.modes === undefined) return;
  const base = agent.tools?.allowlist;
  for (const [mode, def] of Object.entries(agent.modes)) {
    const modeAllow = def.tools?.allowlist;
    if (modeAllow === undefined) continue;
    for (const entry of modeAllow) {
      if (!baseAllowlistPermits(base, entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modes', mode, 'tools', 'allowlist'],
          message: `mode "${mode}" allows tool "${entry}" which the base agent.tools.allowlist does not permit — a mode can only narrow the base tools, never widen them`,
        });
      }
    }
  }
  // A declared defaultMode must name a declared mode.
  if (agent.defaultMode !== undefined && agent.modes[agent.defaultMode] === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultMode'],
      message: `defaultMode "${agent.defaultMode}" is not a declared mode (${Object.keys(agent.modes).join(', ') || 'none'})`,
    });
  }
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

/** One declared mode's shape. */
export type GuueyAgentMode = z.infer<typeof ModeSchema>;

/** The v1 mode axis — the caller's REAL auth state, server-derived. */
export type ModeAudienceClass = 'guest' | 'auth';

/** The result of {@link applyAgentMode} — the effective snapshot + provenance. */
export interface AppliedAgentMode {
  /** The snapshot to SERVE this invoke (a new object when a mode applied; the same reference otherwise). */
  agent: GuueyAgent;
  /** The mode key actually applied, or `null` when serving the bare base. */
  applied: string | null;
  /** Present when the resolution took a non-obvious branch (all fail-soft). */
  fallback?: 'unknown-mode' | 'pin-clamped' | 'auth-undeclared';
}

/**
 * Resolve + apply one invoke's agent mode (guuey#527/#566 — the guest/auth
 * axis, founder-refined 2026-08-31: "letting them use guest mode vs auth
 * mode is the correct definition").
 *
 * SELECTION is SERVER-DERIVED: `audience` is the caller's REAL auth state
 * (the pod maps anonymous → 'guest', authenticated → 'auth') — never a
 * client claim. The `pin` (the widget/SDK `mode` param) may only choose
 * WITHIN permission: an authed caller may pin 'guest' (preview-as-visitor);
 * a guest pinning 'auth' is CLAMPED to guest ('pin-clamped'), and an
 * unrecognized pin key is ignored ('unknown-mode') — fail-soft always, an
 * embed never breaks.
 *
 * Fallback chain: the selected key's def; an undeclared 'auth' falls to
 * 'guest''s def ('auth-undeclared' — an app that only configures the
 * visitor rep serves everyone that rep, which IS hire-a-rep); still
 * nothing → base. `defaultMode` is deprecated and not consulted.
 *
 * Application (unchanged from the first cut, test-pinned): `systemPrompt`
 * REPLACES the base; `systemPromptAppend` = base + "\n\n" + append; an
 * EMPTY def serves the base by SAME REFERENCE (callers detect no-override
 * by identity); `tools` replaces with the write-gate-proven subset; a
 * `{ file }` prompt is unusable at serve time → base. Pure — never
 * mutates inputs.
 */
export function applyAgentMode(
  agent: GuueyAgent,
  pin: string | undefined,
  audience: ModeAudienceClass,
): AppliedAgentMode {
  const modes = agent.modes;
  if (modes === undefined) return { agent, applied: null };

  // ── Selection: derived, then the pin within permission ──────────────
  let fallback: AppliedAgentMode['fallback'];
  let selected: ModeAudienceClass = audience;
  if (pin !== undefined && pin !== audience) {
    if (pin !== 'guest' && pin !== 'auth') {
      fallback = 'unknown-mode'; // ignored; pure derivation stands
    } else if (pin === 'auth' && audience === 'guest') {
      fallback = 'pin-clamped'; // a guest cannot claim auth mode
    } else {
      selected = pin; // authed pinning 'guest' — preview-as-visitor
    }
  }

  // ── Fallback chain: selected → guest → base ─────────────────────────
  let applied: string = selected;
  let def = modes[selected];
  if (def === undefined && selected === 'auth') {
    def = modes['guest'];
    if (def !== undefined) {
      applied = 'guest';
      fallback = fallback ?? 'auth-undeclared';
    }
  }
  if (def === undefined) {
    return { agent, applied: null, ...(fallback !== undefined ? { fallback } : {}) };
  }

  // ── Application (unchanged) ─────────────────────────────────────────
  // An EMPTY def (legal — "at most one") IS the base: same reference out,
  // so callers can cheaply detect "nothing to override" by identity.
  if (def.systemPrompt === undefined && def.systemPromptAppend === undefined && def.tools === undefined) {
    return { agent, applied, ...(fallback !== undefined ? { fallback } : {}) };
  }

  const basePrompt = typeof agent.systemPrompt === 'string' ? agent.systemPrompt : undefined;
  let systemPrompt = agent.systemPrompt;
  if (typeof def.systemPrompt === 'string') {
    systemPrompt = def.systemPrompt;
  } else if (typeof def.systemPromptAppend === 'string') {
    systemPrompt =
      basePrompt !== undefined ? `${basePrompt}\n\n${def.systemPromptAppend}` : def.systemPromptAppend;
  } else if (def.systemPrompt !== undefined || def.systemPromptAppend !== undefined) {
    // { file } shape — unusable at serve time; base verbatim.
    return { agent, applied: null, ...(fallback !== undefined ? { fallback } : {}) };
  }

  return {
    agent: {
      ...agent,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(def.tools !== undefined ? { tools: def.tools } : {}),
    },
    applied,
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

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

  for (const [serverName, server] of declaredServerEntries(servers)) {
    // Only the `external` union arm carries a `headers` field.
    const headers = 'headers' in server ? server.headers : undefined;
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

// ── No-invalid-colocated-names validation (deploy-time contract enforcement) ──
//
// `agent.mcpServers`' key is schema-typed only `z.string().min(1)` — any
// non-empty string parses. But at pod boot, `lowerColocated` composes the
// KEY (not just `source`) into `colocatedResourceUrl(appId, name)`, which
// THROWS for anything outside `/^[A-Za-z0-9_-]+$/` (see `./colocated.ts`).
// An invalid colocated name therefore parses fine client-side and only
// fails once the pod is already booting, as an unactionable
// `POD_FATAL_BOOT_ERROR` crash-loop. `validateColocatedServerNames` is the
// deploy-time pre-flight that catches it first — mirrors
// `validateNoLiteralSecrets`'s shape (explicit lint, called by
// `@guuey/cli`'s `commands/deploy.ts` right before upload).

/**
 * Validate that every `kind: 'colocated'` entry's NAME (the `mcpServers`
 * map key) is safe to compose into `colocatedResourceUrl` — i.e. passes
 * {@link isValidColocatedServerName} (from `./colocated.ts`, the single
 * source of truth for the rule). Returns a list of human-readable
 * violation messages (empty = clean).
 */
export function validateColocatedServerNames(
  agent: GuueyAgent | undefined,
): string[] {
  const violations: string[] = [];
  const servers = agent?.mcpServers;
  if (!servers) return violations;

  for (const [name, server] of declaredServerEntries(servers)) {
    if (server.kind === 'colocated' && !isValidColocatedServerName(name)) {
      violations.push(
        `colocated MCP server name "${name}" is invalid — use only letters, digits, hyphen, underscore (it becomes part of a URL and a storage scope)`,
      );
    }
  }
  return violations;
}

// ── Reserved platform MCP server names (deploy-time reservation) ────────────
//
// Some `mcpServers` map keys are OWNED by the platform: the runtime splices a
// platform-managed entry under them (memmcp — the auto-injected memory MCP is
// spliced under `guuey-memory` for authenticated invokes; see
// `nocode-runtime/src/run-seam.ts` + `boot-colocated.ts`). A builder that
// declares a server under a reserved key would (a) boot as builder code under
// the same key the platform child owns, and (b) be silently REPLACED by the
// platform entry at invoke time. `validateReservedServerNames` is the
// synchronous deploy-time pre-flight that rejects it with a fast, actionable
// 400 — the primary guard; the run-seam collision guard is defense-in-depth for
// stale pre-validator snapshots. Single source of the reserved literal: this
// module. The boot/splice layer (`boot-colocated.ts`) imports it from here.

/**
 * The reserved colocated key the auto-injected memory MCP is booted + spliced
 * under (memmcp). NEVER builder-declarable — the memory child's own server
 * advertises this same name and its aud is `colocatedResourceUrl(appId, this)`.
 */
export const RESERVED_MEMORY_SERVER_NAME = 'guuey-memory';

/**
 * The reserved colocated key the auto-injected cross-app profile MCP is
 * booted + spliced under (profile T1+). NEVER builder-declarable — mirrors
 * {@link RESERVED_MEMORY_SERVER_NAME}'s reservation for the same reason: a
 * builder-declared server under this key would be silently replaced by the
 * platform entry at invoke time.
 */
export const RESERVED_PROFILE_SERVER_NAME = 'guuey-profile';

/**
 * The reserved colocated key the auto-injected human-handoff MCP is booted +
 * spliced under (guuey#552, spec 2026-08-31-human-handoff-v1-design.md).
 * NEVER builder-declarable — mirrors {@link RESERVED_MEMORY_SERVER_NAME}'s
 * reservation for the same reason; the handoff child's own server advertises
 * this name and its aud is `colocatedResourceUrl(appId, this)`.
 */
export const RESERVED_HANDOFF_SERVER_NAME = 'guuey-handoff';

/**
 * Every `mcpServers` map key the platform reserves. Extensible — one entry
 * today ({@link RESERVED_MEMORY_SERVER_NAME}); future platform-injected
 * servers add their key here and inherit the deploy-time rejection for free.
 */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = [
  RESERVED_MEMORY_SERVER_NAME,
  RESERVED_PROFILE_SERVER_NAME,
  RESERVED_HANDOFF_SERVER_NAME,
];

/**
 * Validate that no `agent.mcpServers` entry uses a platform-RESERVED name
 * ({@link RESERVED_MCP_SERVER_NAMES}) — regardless of `kind` (the key is
 * reserved, not just one hosting mode; a builder must not shadow it as
 * `colocated`, `external`, or anything else). Returns a list of human-readable
 * violation messages (empty = clean), one per reserved entry. Mirrors
 * {@link validateColocatedServerNames}'s shape.
 */
export function validateReservedServerNames(
  agent: GuueyAgent | undefined,
): string[] {
  const violations: string[] = [];
  const servers = agent?.mcpServers;
  if (!servers) return violations;

  for (const name of Object.keys(servers)) {
    if (RESERVED_MCP_SERVER_NAMES.includes(name)) {
      violations.push(
        `MCP server "${name}": that name is reserved by the platform (an auto-injected server uses it) — rename this server.`,
      );
    }
  }
  return violations;
}

// ── Tool-gate grammar (guuey#234) ────────────────────────────────────────────
//
// `agent.tools.{allowlist,denylist}` entries are schema-typed only
// `z.string().min(1)`. Before #234 the Claude host passed the allowlist
// VERBATIM into the SDK's `allowedTools` (which speaks `mcp__<server>__<tool>`)
// and nothing consumed the denylist at all — so the documented `<server>.<tool>`
// grammar was inert, and a mis-spelled entry could only surface at turn time,
// where an unrecognized name on a headless pod means an interactive permission
// prompt nobody answers. `parseToolGateEntry` is the ONE grammar (config side);
// `validateToolGates` is the deploy-time pre-flight (mirrors
// `validateReservedServerNames`'s shape — called by `@guuey/cli`'s
// `commands/deploy.ts` and, authoritatively, the cliApi deploy handler); the
// host translates the parsed shape into its framework's own tool names.

/** One parsed `tools.allowlist` / `tools.denylist` entry. */
export type ToolGateEntry =
  /** `"<server>.<tool>"` — one tool of one server. */
  | { kind: 'server-tool'; server: string; tool: string }
  /** `"<server>.*"` — every tool of one server. */
  | { kind: 'server-all'; server: string }
  /** `"<tool>"` — that tool on every connected server (and the built-in of that name). */
  | { kind: 'bare'; tool: string };

/**
 * The framework-internal MCP tool-name prefix (Claude Agent SDK:
 * `mcp__<server>__<tool>`). Rejected in config — builders write the
 * `<server>.<tool>` grammar; the host translates.
 */
const SDK_INTERNAL_TOOL_PREFIX = /^mcp__/;

/**
 * Parse one tool-gate entry per the {@link ToolGatesSchema} grammar. Returns
 * the parsed shape, or a human-readable reason string when the entry is
 * malformed (never throws — callers decide whether to reject or report).
 */
export function parseToolGateEntry(raw: string): ToolGateEntry | { error: string } {
  const entry = raw.trim();
  if (entry.length === 0) return { error: 'empty entry' };
  if (SDK_INTERNAL_TOOL_PREFIX.test(entry)) {
    return {
      error: `"${entry}" uses the framework-internal spelling — write "<server>.<tool>" (or "<server>.*", or a bare tool name) instead`,
    };
  }
  const dot = entry.indexOf('.');
  if (dot === -1) return { kind: 'bare', tool: entry };
  const server = entry.slice(0, dot);
  const tool = entry.slice(dot + 1);
  if (server.length === 0) return { error: `"${entry}" has an empty server name before the dot` };
  if (tool.length === 0) return { error: `"${entry}" has an empty tool name after the dot` };
  if (tool === '*') return { kind: 'server-all', server };
  if (tool.includes('*')) {
    return { error: `"${entry}": wildcards are only valid as the whole tool part ("${server}.*")` };
  }
  return { kind: 'server-tool', server, tool };
}

/**
 * The server names a tool-gate entry may qualify with: every EFFECTIVE server
 * (declared map with the platform default seeded and `ggui: false` honoured —
 * {@link effectiveMcpServers}) plus the platform-injected reserved servers
 * ({@link RESERVED_MCP_SERVER_NAMES}: memory / profile, spliced at invoke time
 * for authenticated callers).
 */
export function toolGateServerNames(agent: GuueyAgent | undefined): string[] {
  return [
    ...Object.keys(effectiveMcpServers(agent?.mcpServers)),
    ...RESERVED_MCP_SERVER_NAMES,
  ];
}

/**
 * Validate `agent.tools.allowlist` / `agent.tools.denylist` at deploy time
 * (guuey#234). Every entry must parse per {@link parseToolGateEntry}, and a
 * server-qualified entry must name a server this agent connects
 * ({@link toolGateServerNames}). Returns a list of human-readable violation
 * messages (empty = clean). Tool-level existence against a server's live
 * manifest is NOT checked here (a hosted server's tool set is only known once
 * it is connected) — that is why the host DENIES an unlisted pick at turn time
 * instead of prompting.
 */
export function validateToolGates(agent: GuueyAgent | undefined): string[] {
  const violations: string[] = [];
  const gates = agent?.tools;
  if (!gates) return violations;
  const known = new Set(toolGateServerNames(agent));
  for (const list of ['allowlist', 'denylist'] as const) {
    for (const raw of gates[list] ?? []) {
      const parsed = parseToolGateEntry(raw);
      if ('error' in parsed) {
        violations.push(`tools.${list}: ${parsed.error}`);
        continue;
      }
      if (parsed.kind !== 'bare' && !known.has(parsed.server)) {
        violations.push(
          `tools.${list}: "${raw}" names MCP server "${parsed.server}", which this agent does not connect — declare it under mcpServers or use one of: ${[...known].join(', ')}`,
        );
      }
    }
  }
  return violations;
}

/**
 * Platform default MCP server map. Seeded under every declared map by
 * {@link effectiveMcpServers} (opt out with `ggui: false`). Exposed here so
 * non-pod consumers (CLI dry-run, lints) can show the effective shape without
 * duplicating the literal.
 *
 * The ggui server is `kind: 'external'` — it is builder-declared when present
 * or injected by the platform at runtime. Federation still detects it by host
 * (via `isGguiUrl`) regardless of which key it's declared under.
 */
export const DEFAULT_AGENT_MCP_SERVERS: Record<string, GuueyAgentMcpServer> = {
  ggui: { kind: 'external', url: 'https://mcp.ggui.ai', transport: 'http' },
};

/**
 * The EFFECTIVE server map (guuey#24, option A): seed the platform default,
 * layer the declared map on top (explicit wins), drop `ggui: false`. This is
 * the ONE owner of default-application semantics — the resolution seams
 * (credential broker, render-tool resolution) call this; declared-map
 * ITERATION sites use {@link declaredServerEntries} instead.
 */
export function effectiveMcpServers(
  declared: DeclaredMcpServers | undefined
): Record<string, GuueyAgentMcpServer> {
  const merged: DeclaredMcpServers = { ...DEFAULT_AGENT_MCP_SERVERS, ...declared };
  const out: Record<string, GuueyAgentMcpServer> = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (entry !== false) out[name] = entry;
  }
  return out;
}

/** The declared entries that are real servers (the `ggui: false` opt-out filtered out) — the narrowing every declared-map iteration site uses. */
export function declaredServerEntries(
  servers: DeclaredMcpServers | undefined
): Array<[string, GuueyAgentMcpServer]> {
  return Object.entries(servers ?? {}).filter(
    (e): e is [string, GuueyAgentMcpServer] => e[1] !== false
  );
}
