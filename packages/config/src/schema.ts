/**
 * `guuey.json` v1 — the Guuey hosted overlay.
 *
 * Companion file to `ggui.json` (the open portable manifest owned by
 * `@ggui-ai/project-config`). `guuey.json` carries ONLY what Guuey
 * hosting needs in addition to `ggui.json` — the platform project
 * identity, the hosted deploy shape, deploy records, and any future
 * hosted control-plane state. It does NOT duplicate portable agent
 * identity / blueprints / policy fields; those live in `ggui.json`
 * and this file is strictly additive.
 *
 * **Pre-2026-04-18 history (pruned):** earlier drafts of this schema
 * mirrored the portable `agent` / `blueprints` / `policy` shape from
 * `ggui.json` as an artefact of the pre-two-file single-primitive
 * design. Those fields were removed so `guuey.json` is clearly a
 * hosted overlay, not a second source of truth. See
 * `docs/plans/2026-04-17-ggui-oss-split.md` §8 for the two-file lock
 * (`ba7a0006`) and the ownership rationale.
 *
 * **2026-04-20 expansion:** the v1 document gained two optional
 * top-level blocks — `project` (platform identity: `id`, `workspaceId`)
 * and `deploy` (canonical hosted deploy shape: `size`, `runtime`,
 * `region`). Both are still absent on a fresh project; they appear the
 * first time `guuey pull` / `guuey deploy` populate them. The
 * version pin was renamed from `version: '1'` to `schema: '1'` to
 * match `ggui.json#schema` — unified vocabulary across both files.
 *
 * **Rules for extending:**
 *
 * 1. **Additive only within `schema: '1'`.** New optional fields on
 *    existing objects are safe. New top-level fields must default to
 *    behavioural no-ops so older tooling can ignore them.
 * 2. **Overlay-only.** Fields must be things only Guuey the platform
 *    understands — workspace/account IDs, hosted deploy state, the
 *    managed proxy config, Guuey-specific deploy/pull metadata.
 *    Portable fields (agent identity, blueprints, policy defaults)
 *    belong in `ggui.json`; do NOT mirror them here.
 * 3. **No local-dev fields.** Bridge URLs, WebSocket endpoints,
 *    render URLs, local quality toggles — those belong in `.env` or
 *    project-local config, not in a git-versioned overlay.
 */
import { z } from 'zod';
import { AGENT_SIZES } from './hosting.js';
import { McpProxiesSchema } from './mcp-proxy.js';
import { McpServersSchema } from './mcp-servers.js';

/**
 * A single deployment record — Guuey writes one of these per
 * successful `guuey deploy`. Kept deliberately small: the authoritative
 * deploy state (build logs, rollout status, routing metadata) lives
 * on the Guuey control-plane API, not in this file. `guuey pull`
 * refreshes these records from the API.
 *
 * `target` stays `'local' | 'guuey'` rather than a single `'guuey'`
 * literal — a Guuey-managed project may register self-hosted endpoints
 * alongside hosted ones (e.g., a paired laptop during dev). Narrowing
 * the union is a later design decision.
 *
 * `buildId` joins the record to the hosted control-plane build / log
 * store. Optional because `target: 'local'` entries have no hosted
 * build associated with them.
 */
const DeploymentSchema = z.object({
  target: z.enum(['local', 'guuey']),
  url: z.url(),
  /** ISO 8601 timestamp of the last successful deploy to this target. */
  deployedAt: z.iso.datetime().optional(),
  /**
   * Opaque hosted build identifier (e.g., `build_01K9FY7XYZ`). Present
   * on `target: 'guuey'` records written by `guuey deploy`; omitted on
   * `target: 'local'` entries. Used by `guuey deployments logs` to
   * correlate back to the build artefact.
   */
  buildId: z.string().min(1).optional(),
});

/**
 * Platform identity block. Required fields are the two stable
 * identifiers Guuey hosting uses to route a project: the project id
 * (app/project row on the hosted control plane) and the workspace id
 * it belongs to.
 *
 * The block itself is OPTIONAL at the top level — a fresh OSS-first
 * project has no Guuey project identity until `guuey link` / `guuey
 * pull` writes it.
 *
 * `id` is required once the block is present. `workspaceId` is
 * OPTIONAL (2026-04-21 widening) — `guuey create` and `guuey link`
 * can stamp `{project: {id}}` immediately off the `POST /apps`
 * response (which returns `appId` but NOT `workspaceId`), and
 * `guuey pull` later enriches the field when the hosted `GET
 * /apps/:appId` emission confirms a workspace. Personal-scope
 * apps (no workspace membership) legitimately carry no
 * `workspaceId` in their overlay and stay valid.
 */
const ProjectSchema = z.object({
  /** Stable project identifier minted by the Guuey control plane. */
  id: z.string().min(1).max(128),
  /**
   * Workspace the project lives under. Optional — absent for
   * personal-scope apps and for workspace-scoped apps that haven't
   * been `guuey pull`-enriched yet.
   */
  workspaceId: z.string().min(1).max(128).optional(),
});

/**
 * Canonical hosted deploy shape — the values Guuey hosting uses when
 * it stands up a runtime for this project. Kept intentionally narrow:
 * these are the fields `guuey deploy` reads at push-time and `guuey
 * pull` refreshes from the hosted record. Anything transient
 * (build-size overrides, per-deploy flags) belongs on the command
 * line, not in the overlay.
 *
 * The block is OPTIONAL — a fresh project has no deploy shape on
 * disk until it's been written once.
 */
const DeploySchema = z.object({
  /**
   * Agent container size. Canonical list is `AGENT_SIZES` in
   * `hosting.ts` — keeping the two in sync keeps the hosted type
   * system and the overlay from drifting.
   */
  size: z.enum(AGENT_SIZES).optional(),
  /**
   * Node runtime pin for hosting. Free-form string today
   * (e.g., `"node22"`) — hosted control-plane is the source of
   * truth for the supported set and validates at deploy time.
   * Narrow to an enum later if the supported set stabilises.
   */
  runtime: z.string().min(1).optional(),
  /**
   * AWS region (e.g., `"us-east-1"`). Free-form string; the Guuey
   * control plane enforces the live region allow-list. Keeping
   * this unenumerated avoids churning the overlay every time we
   * add a region.
   */
  region: z.string().min(1).optional(),
});

/**
 * The authoritative v1 schema. `z.infer<typeof GuueyJsonV1>` yields
 * the static TypeScript type. A valid document round-trips cleanly:
 * parse → `JSON.stringify` → re-parse produces an equivalent value.
 *
 * **Current v1 fields:** `schema`, optional `project`, optional
 * `deploy`, defaulted `deployments`, optional `mcpProxies`, optional
 * `mcpServers`. Additional overlay fields (future hosting blocks,
 * managed-registration state, …) land as additive extensions when
 * their consumer work catches up — each one is its own decision with
 * a consumer-rewire plan.
 *
 * **2026-04-21 — `mcpProxies` added.** Overlay-explicit Guuey-hosted
 * managed-MCP-relay declaration block. Schema owned by the
 * {@link McpProxiesSchema} module in this same package. Previously
 * blocked on the `mcp-proxy.ts` classification split (§8.2); that
 * block resolved 2026-04-21.
 *
 * **2026-04-21 — `mcpServers` added.** Overlay-explicit Guuey-hosted
 * relayed-MCP-server declaration block. Schema owned by the
 * {@link McpServersSchema} module in this same package. Previously
 * blocked on the `McpServerAuthConfig` classification split in
 * `@ggui-ai/protocol/types/credential.ts`; that block resolved
 * 2026-04-21 with the mirror of the `mcp-proxy` classification fix.
 */
export const GuueyJsonV1 = z.object({
  schema: z.literal('1'),
  project: ProjectSchema.optional(),
  deploy: DeploySchema.optional(),
  deployments: z.array(DeploymentSchema).default([]),
  /**
   * Managed MCP-relay declarations. Keys are proxy identifiers
   * (`claude_ai`, `guuey`, future `omo`, …); values declare the
   * discovery + proxy URL pattern + optional OAuth linking + optional
   * server filter for each relay. The hosted `guuey` CLI + hosted
   * Guuey services are the authoritative consumers; open `@ggui-ai/
   * server` code reads it through a local structural shape (see the
   * consumer-rewire notes in `@ggui-ai/server/proxies/resolve-
   * proxies.ts` and `@ggui-ai/server/claude-agent-sdk/create-
   * agent.ts`).
   */
  mcpProxies: McpProxiesSchema.optional(),
  /**
   * Relayed MCP server declarations. Keys are server names (`gmail`,
   * `calendar`, future `slack`, …); values declare the upstream HTTP
   * URL + optional auth block pointing at a Guuey credential-store
   * `serviceId`. The hosted `guuey` CLI + `@guuey/bridge` + hosted
   * Guuey services are the authoritative consumers; open `@ggui-ai/
   * server` code reads the auth block through a local structural
   * shape (see consumer-rewire notes in `@ggui-ai/server/sessions/
   * agent-session.ts` and `@ggui-ai/server/mcp-auth-middleware.ts`).
   */
  mcpServers: McpServersSchema.optional(),
});

/** Static TypeScript type derived from the v1 schema. */
export type GuueyJsonV1 = z.infer<typeof GuueyJsonV1>;

/** Static TypeScript type derived from the {@link ProjectSchema} block. */
export type GuueyJsonProject = z.infer<typeof ProjectSchema>;

/** Static TypeScript type derived from the {@link DeploySchema} block. */
export type GuueyJsonDeploy = z.infer<typeof DeploySchema>;

/** Static TypeScript type derived from a single deployment record. */
export type GuueyJsonDeployment = z.infer<typeof DeploymentSchema>;

/**
 * Canonical filename — always at the project root, always this name.
 * Exported so tooling uses the same constant instead of hard-coding
 * the string.
 */
export const GUUEY_JSON_FILENAME = 'guuey.json';

/**
 * Parse a raw JSON value into a validated {@link GuueyJsonV1}.
 * Throws a `ZodError` with human-readable issues on invalid input.
 *
 * Accepts any `unknown` — callers are expected to have already
 * decoded the JSON (`JSON.parse(source)`). The v1 schema fills
 * the `deployments` default when the field is absent.
 */
export function parseGuueyJson(raw: unknown): GuueyJsonV1 {
  return GuueyJsonV1.parse(raw);
}

/**
 * Safe-parse variant — returns a discriminated `z.safeParse` result
 * (`{ success: true, data }` vs `{ success: false, error }`). Prefer
 * this inside CLI tooling where you want to render the issue list
 * without try/catch.
 */
export function safeParseGuueyJson(
  raw: unknown,
): ReturnType<typeof GuueyJsonV1.safeParse> {
  return GuueyJsonV1.safeParse(raw);
}
