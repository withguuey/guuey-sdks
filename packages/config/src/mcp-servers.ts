/**
 * `mcpServers` — Guuey hosted overlay shape for relayed MCP server
 * declarations.
 *
 * Relocated 2026-04-21 from `@ggui-ai/protocol/types/credential.ts`
 * as part of the OSS split §8.2 classification fix (mirror of the
 * 2026-04-21 `mcp-proxy` split). The `McpServerAuthConfig` type
 * previously lived in the open protocol package with a docstring
 * that said "Auth config in guuey.json mcpServers entries" — an
 * overlay-shape type in an open package, exactly the pattern the
 * mcp-proxy split closed.
 *
 * ## The classification decision
 *
 * `mcpServers` is the declaration block a developer adds to
 * `guuey.json` to tell Guuey hosting: *"for this project, relay
 * these HTTP MCP servers through the Guuey bridge, authenticating
 * each via the credential stored under this `serviceId`."* That is
 * platform-layer plumbing — the Guuey bridge registers the
 * declaration with the Guuey-hosted WebSocket gateway, and the
 * Guuey mcp-proxy Lambda resolves `auth.serviceId` against the
 * platform's UserCredential store. An OSS-only `ggui serve`
 * deployment has no analog for `auth.serviceId` because there is no
 * Guuey credential store.
 *
 * Per §8.2: the OSS `ggui` server does NOT read `guuey.json`.
 * Consumers that need this overlay value (the closed `guuey` CLI's
 * `guuey dev` command, the closed `@guuey/bridge` package, Guuey-
 * hosted Lambdas) are the only call sites allowed to import from
 * this package. Open packages that historically read
 * `McpServerAuthConfig` (`@ggui-ai/server`'s auth-relay code) now
 * inline the minimal structural shape they actually use.
 *
 * ## Scope of this module
 *
 * - {@link CredentialInjection} + {@link CredentialInjectionConfig}
 *   — runtime injection-mode descriptors, used here as
 *   `McpServerAuth.injection` and also exported from
 *   `@ggui-ai/protocol/types/credential.ts` for cloud-side runtime
 *   consumers. The overlap is intentional and minor (10 lines of
 *   literal-union type) — duplicating inline keeps this private
 *   package dep-minimal (zod-only). If the two ever drift, the
 *   consolidation fix is to add `@ggui-ai/protocol` as a workspace
 *   dep here; today the duplication is cheaper than that cross-
 *   boundary edge.
 * - {@link McpServerAuthConfig} — auth block on a single
 *   `mcpServers` entry. `serviceId` references the Guuey
 *   credential store; `preInject` + `injection` tune how the relay
 *   writes the placeholder.
 * - {@link McpServerEntryConfig} — a single mcpServers entry
 *   (`{ url, auth? }`). `url` is the HTTP MCP server endpoint.
 * - {@link McpServersConfig} — the top-level record keyed by MCP
 *   server name (`gmail`, `calendar`, future `slack`, …). Exactly
 *   the shape `guuey.json#mcpServers` carries.
 *
 * ## Strictness
 *
 * Zod validation matches the rest of `guuey.json`: strict objects,
 * non-empty strings, URL validation on `url`. Unknown keys on
 * nested objects fail parse (prevents silent drift toward a "what
 * else can we stuff into guuey.json" shape).
 */
import { z } from 'zod';

/**
 * Injection mode — how the Guuey mcp-proxy splices the resolved
 * credential into the outbound HTTP request to the upstream MCP
 * server. Duplicated minor from
 * `@ggui-ai/protocol/types/credential.ts#CredentialInjection`; see
 * module docstring for the duplication rationale.
 */
const CredentialInjectionSchema = z.enum([
  'bearer_header',
  'api_key_header',
  'query_param',
  'custom_header',
]);

/** Full injection config — `mode` + per-mode tunables. */
const CredentialInjectionConfigSchema = z.strictObject({
  mode: CredentialInjectionSchema,
  /** Header name for `api_key_header` / `custom_header`. Default: `X-API-Key`. */
  headerName: z.string().min(1).optional(),
  /** Query param name for `query_param`. Default: `api_key`. */
  paramName: z.string().min(1).optional(),
});

/**
 * Auth block on a single `mcpServers` entry. All fields are
 * optional at the block level — a server without `auth` is relayed
 * without credential injection (public MCP endpoint).
 */
const McpServerAuthSchema = z.strictObject({
  /**
   * Service ID referenced against the Guuey platform's
   * UserCredential store. This is a Guuey-platform concept — an
   * OSS-only deployment has no equivalent lookup.
   */
  serviceId: z.string().min(1),
  /**
   * Pre-inject placeholder before the first upstream request
   * (skips the 401 → consent → retry dance for cases where the
   * user has already linked the credential). Default: `false`.
   */
  preInject: z.boolean().optional(),
  /**
   * Override the injection mode. Falls back to the
   * `McpServiceConfig` table entry keyed by `serviceId`, which
   * defaults to `bearer_header`.
   */
  injection: CredentialInjectionConfigSchema.optional(),
  /**
   * Optional OAuth scope hint forwarded to the hosted bridge at
   * connect time. The platform consumes this when minting tokens
   * against the upstream MCP server. Preserved here (2026-04-21)
   * for wire-compat with `@guuey/bridge`'s existing inline shape,
   * which flows `auth.scopes` through the bridge WebSocket config
   * message.
   */
  scopes: z.array(z.string().min(1)).optional(),
});

/**
 * A single `mcpServers` entry. `url` is the HTTP MCP server
 * endpoint; `auth` scopes the credential injection.
 */
const McpServerEntrySchema = z.strictObject({
  /** HTTP MCP server endpoint. */
  url: z.url(),
  /** Optional auth block — omit for public endpoints. */
  auth: McpServerAuthSchema.optional(),
});

/**
 * The `mcpServers` section of `guuey.json`. Keys are MCP server
 * display names (`gmail`, `calendar`, future `slack`, …) —
 * arbitrary strings, by design. New servers are additive; a fixed
 * literal union would force a schema change every time a new MCP
 * server integration lands.
 */
export const McpServersSchema = z.record(
  z.string().min(1),
  McpServerEntrySchema,
);

/** Runtime injection-mode descriptor type. */
export type CredentialInjection = z.infer<typeof CredentialInjectionSchema>;

/** Injection-config block type. */
export type CredentialInjectionConfig = z.infer<
  typeof CredentialInjectionConfigSchema
>;

/** Auth-block type on an `mcpServers` entry. */
export type McpServerAuthConfig = z.infer<typeof McpServerAuthSchema>;

/** Single-entry type inside the `mcpServers` record. */
export type McpServerEntryConfig = z.infer<typeof McpServerEntrySchema>;

/** Full `mcpServers` overlay type derived from the zod schema. */
export type McpServersConfig = z.infer<typeof McpServersSchema>;

/**
 * Parse a raw JSON value into a validated {@link McpServersConfig}.
 * Throws a `ZodError` on invalid input.
 */
export function parseMcpServers(raw: unknown): McpServersConfig {
  return McpServersSchema.parse(raw);
}

/** Safe-parse variant — see {@link parseMcpServers}. */
export function safeParseMcpServers(
  raw: unknown,
): ReturnType<typeof McpServersSchema.safeParse> {
  return McpServersSchema.safeParse(raw);
}
