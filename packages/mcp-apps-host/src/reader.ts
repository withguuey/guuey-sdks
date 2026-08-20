/**
 * The generic SEP-1865 locator reader (guuey#127): resolve a persisted
 * `ui://` locator ({@link LocatorViewMount}) into a mountable
 * {@link ResolvedViewMount} by ONE fresh `resources/read` over a transport
 * the HOST supplies.
 *
 * The transport is a structural callable — deliberately no
 * `@modelcontextprotocol/sdk` dependency — because hosts hold wildly
 * different connections: a raw MCP client (ggui's `with-guuey-web` sample
 * keeps one for guest `tools/call` relay), an authenticated platform proxy
 * (`@guuey/agent-client`'s `createUiResourceReader` is exactly this assembly
 * over guuey's `GET /v1/threads/:threadId/ui-resource` route), or anything
 * else that can perform one read. The host adapts whatever client it holds.
 *
 * Trust rules, identical to the platform reader and now in ONE place:
 *
 *  - a transport deny, a miss, and a thrown transport error are all
 *    `undefined` → the host renders its placeholder, never an error surface
 *    (deny == miss — no oracle for which locators resolve);
 *  - enforcement (user-ownership, tenancy, credential handling) belongs
 *    INSIDE the transport, before any bytes come back — this assembly never
 *    sees a credential;
 *  - the sandbox-trust channel derives from the REQUESTED locator uri, never
 *    from the response — a server answering with a foreign `ui://ggui/…` uri
 *    must not steer its HTML into the ggui-CSP host page.
 */
import { McpUiResourceCspSchema, type McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import type { McpUiResourcePayload } from "./block-ui.js";
import type { ResolvedViewMount, ViewMountChannel } from "./card-mount.js";

/**
 * One `resources/read` `contents[]` entry, structurally (SEP-1865). Kept a
 * separate type from {@link McpUiResourcePayload} even though the shapes
 * coincide today: this is the UNVALIDATED wire-side entry a transport hands
 * over, while the payload is the narrowed thing a host mounts. `_meta` is
 * phase 2's growth (guuey#312, conformance map step 3): the per-resource
 * declarations (`_meta.ui.csp` — MCP Apps SEP-1865) ride here when the
 * transport forwards them; {@link declaredResourceCsp} is the ONLY door
 * from this open extension map into typed material.
 */
export interface McpResourceReadResult {
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64 payload arm — hosts decode via {@link resourceHtml}. */
  blob?: string;
  /**
   * The entry's `_meta` as the transport saw it — an open extension map,
   * so genuinely unknown-shaped at this boundary; never read it directly,
   * narrow through {@link declaredResourceCsp}.
   */
  _meta?: unknown;
}

/**
 * The server's per-resource CSP declaration from a read result's
 * `_meta.ui.csp` (guuey#312 — the phase-2 channel `uiResourceChannel`'s
 * docs promised). Validated against the SPEC's own schema
 * (`McpUiResourceCspSchema` from `@modelcontextprotocol/ext-apps`), never
 * a hand-rolled mirror. Malformed or absent → `undefined` — an undeclared
 * resource is the secure default (consumers only ever use a declaration to
 * build allowances; absence widens nothing).
 */
export function declaredResourceCsp(entry: McpResourceReadResult): McpUiResourceCsp | undefined {
  const meta = entry._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta) || !("ui" in meta)) {
    return undefined;
  }
  const ui: unknown = meta.ui;
  if (typeof ui !== "object" || ui === null || Array.isArray(ui) || !("csp" in ui)) {
    return undefined;
  }
  const parsed = McpUiResourceCspSchema.safeParse(ui.csp);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Phase-1 sandbox-trust channel resolution (conformance map, retirement
 * step 3): a `ui://ggui/…` locator mounts through the ggui-CSP host page
 * (`"ggui"` — the shell boots ggui's runtime bundle and opens its WSS),
 * anything else through the self-only page (`"inline"` — arbitrary tenant
 * HTML). The declaration itself ships (guuey#312 — `ResolvedViewMount.csp`
 * via {@link declaredResourceCsp}); this heuristic retires when hosts route
 * SANDBOX TRUST from that declaration too (per-card CSP construction, the
 * conformance map's step-3 second half). Until then the uri prefix is the only
 * signal a host has BEFORE fetching mount material.
 */
export function uiResourceChannel(resourceUri: string): Exclude<ViewMountChannel, "locator"> {
  return resourceUri.startsWith("ui://ggui/") ? "ggui" : "inline";
}

/** The host-supplied transport {@link createMcpUiResourceReader} assembles over. */
export interface CreateMcpUiResourceReaderDeps {
  /**
   * One `resources/read` of `uri` on the host's own MCP connection (or an
   * equivalent authenticated proxy), returning the first `contents[]` entry —
   * or `undefined` when the read yields none. Throwing is treated as a miss.
   */
  readResource: (uri: string) => Promise<McpResourceReadResult | undefined>;
}

/**
 * Assemble a `UiResourceReader` from a host-supplied `resources/read`
 * transport. The returned reader resolves only the mountable arms — a read
 * either yields mount material or the honest placeholder, never another
 * locator.
 */
export function createMcpUiResourceReader(
  deps: CreateMcpUiResourceReaderDeps,
): (resourceUri: string) => Promise<ResolvedViewMount | undefined> {
  return async (resourceUri) => {
    let entry: McpResourceReadResult | undefined;
    try {
      entry = await deps.readResource(resourceUri);
    } catch {
      return undefined; // transport failure == deny == miss → placeholder
    }
    if (!entry) return undefined;
    // Runtime re-narrowing, not trust in the annotation: transports are
    // host-supplied and may be plain JS. Same field rules as `asResourcePayload`,
    // applied to the typed entry (which may carry extra wire fields — dropped).
    if (typeof entry.uri !== "string") return undefined;
    if (typeof entry.text !== "string" && typeof entry.blob !== "string") return undefined;
    const resource: McpUiResourcePayload = {
      uri: entry.uri,
      ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
      ...(typeof entry.text === "string" ? { text: entry.text } : {}),
      ...(typeof entry.blob === "string" ? { blob: entry.blob } : {}),
    };
    // guuey#312: the per-resource CSP declaration rides the resolved mount
    // when the wire carried one — hosts build per-card allowances from the
    // DECLARATION, never from the uri prefix. Absent = undeclared (secure
    // default); never fabricated.
    const csp = declaredResourceCsp(entry);
    return {
      channel: uiResourceChannel(resourceUri),
      resource,
      ...(csp !== undefined ? { csp } : {}),
    };
  };
}
