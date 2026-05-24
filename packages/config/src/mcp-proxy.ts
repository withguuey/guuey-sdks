/**
 * `mcpProxies` — Guuey hosted overlay shape for managed MCP relays.
 *
 * Relocated 2026-04-21 from `@ggui-ai/protocol/types/mcp-proxy.ts` as
 * part of the OSS split §8.2 classification fix. These types describe
 * a GUUEY HOSTING CONCEPT (a managed proxy that relays MCP calls with
 * upstream OAuth linking), not a vendor-neutral protocol shape, and
 * therefore belong in the closed `@guuey/config`
 * package alongside the rest of `guuey.json`.
 *
 * ## The classification decision
 *
 * `mcpProxies` is the declaration block a developer adds to
 * `guuey.json` to tell Guuey hosting: *"on behalf of this project,
 * relay these external MCP providers, using this OAuth linking
 * config, exposing these discovered servers."* That is
 * platform-layer plumbing — Guuey runs the relay, handles the
 * credential storage, dispatches the discovery — and it does not
 * describe anything an OSS-only `ggui` deployment emits or consumes.
 *
 * Per §8.2: the OSS `ggui` server does NOT read `guuey.json`.
 * Consumers that need overlay values (the closed `guuey` CLI,
 * Guuey-hosted Lambdas, the Guuey-internal control-plane UI) are
 * the only call sites allowed to import from this package. Open
 * packages that historically read `mcpProxies` (`@ggui-ai/server`'s
 * Claude-passthrough feature) retain their feature code but inline
 * the minimal structural shape they actually use — it stays a
 * Guuey-platform plumbing path, not a protocol contract.
 *
 * ## Scope of this module
 *
 * - {@link McpProxyLinkingConfig} — upstream OAuth config for
 *   proxies that relay calls on behalf of an external account
 *   (e.g. Claude.ai). Keys surface in the Guuey control plane's
 *   credential-linking UI.
 * - {@link McpProxyConfig} — a single proxy's discovery + proxy
 *   URL pattern + optional server filter + optional linking block.
 * - {@link McpProxiesConfig} — the top-level record keyed by
 *   proxy id (`claude_ai`, `guuey`, future `omo`...). Exactly the
 *   shape `guuey.json#mcpProxies` carries.
 *
 * ## Vendor-neutral constants stay in `@ggui-ai/protocol`
 *
 * Claude.ai-specific constants and discovery-response wire types
 * (`CLAUDE_AI_*`, `DiscoveredMcpServer`, `ClaudeAiDiscoveryResponse`)
 * remain in `@ggui-ai/protocol/types/mcp-proxy.ts` — those describe
 * Anthropic's public API, not Guuey-overlay config.
 *
 * ## Strictness
 *
 * Zod validation matches the rest of `guuey.json`: strict objects,
 * non-empty strings, URL validation on linking endpoints. Unknown
 * keys on nested objects fail parse (prevents silent drift toward
 * a "what else can we stuff into guuey.json" shape).
 */
import { z } from 'zod';

/**
 * OAuth linking config for proxies that relay on behalf of an
 * external account. Omit for proxies where Guuey session auth is
 * the only identity needed (e.g. a Guuey-native proxy).
 */
const McpProxyLinkingSchema = z.strictObject({
  /** OAuth authorize endpoint. */
  authUrl: z.url(),
  /** OAuth token endpoint. */
  tokenUrl: z.url(),
  /**
   * OAuth scopes to request. Empty array means "use the upstream's
   * default scope set"; it does NOT mean "no scopes at all."
   */
  scopes: z.array(z.string().min(1)),
  /**
   * OAuth client_id to use. When omitted, the proxy uses a
   * well-known public client_id (e.g. Claude Code's registered
   * client for Claude.ai).
   */
  clientId: z.string().min(1).optional(),
  /**
   * Manual redirect URL for environments without a localhost
   * callback. The upstream AS redirects here and renders the
   * authorization code for the user to copy-paste. Used by
   * production web flows.
   */
  manualRedirectUrl: z.url().optional(),
});

/**
 * Configuration for a single MCP proxy in `guuey.json#mcpProxies`.
 *
 * `discovery` + `proxy` are both URL-valued, but `proxy` is a URL
 * PATTERN (contains `{server_id}` which is substituted at call
 * time). Both are validated as URLs — `{server_id}` is accepted
 * by URL parsers as opaque path segment.
 */
const McpProxyConfigSchema = z.strictObject({
  /** Discovery URL — fetches available MCP servers for this proxy. */
  discovery: z.url(),
  /**
   * Proxy URL pattern — `{server_id}` is substituted with the
   * discovered server id at relay time. Validated as URL; the
   * placeholder survives URL parsing as an opaque path segment.
   */
  proxy: z.url(),
  /**
   * OAuth linking config for upstream account linking. Omit for
   * Guuey-native proxies where the session token is sufficient.
   */
  linking: McpProxyLinkingSchema.optional(),
  /**
   * Filter which discovered servers to expose, matched by display
   * name. When omitted, all discovered servers are exposed.
   */
  servers: z.array(z.string().min(1)).optional(),
});

/**
 * The `mcpProxies` section of `guuey.json`. Keys are proxy
 * identifiers (`claude_ai`, `guuey`, future `omo`, …).
 *
 * Record shape intentionally — new proxy ids are additive; a fixed
 * literal union here would force a schema change every time a new
 * hosted-relay integration lands.
 */
export const McpProxiesSchema = z.record(
  z.string().min(1),
  McpProxyConfigSchema,
);

/** Linking block type derived from the zod schema. */
export type McpProxyLinkingConfig = z.infer<typeof McpProxyLinkingSchema>;

/** Single-proxy config type derived from the zod schema. */
export type McpProxyConfig = z.infer<typeof McpProxyConfigSchema>;

/** Full `mcpProxies` overlay type derived from the zod schema. */
export type McpProxiesConfig = z.infer<typeof McpProxiesSchema>;

/**
 * Parse a raw JSON value into a validated {@link McpProxiesConfig}.
 * Throws a `ZodError` on invalid input.
 */
export function parseMcpProxies(raw: unknown): McpProxiesConfig {
  return McpProxiesSchema.parse(raw);
}

/** Safe-parse variant — see {@link parseMcpProxies}. */
export function safeParseMcpProxies(
  raw: unknown,
): ReturnType<typeof McpProxiesSchema.safeParse> {
  return McpProxiesSchema.safeParse(raw);
}
