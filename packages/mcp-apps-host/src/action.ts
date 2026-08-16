/**
 * The Host role's ACTION side (guuey#158) — the `tools/call` sibling of
 * `reader.ts`. A mounted card's sandbox posts a runtime action to the host
 * (SEP-1865 / ggui's relay-host contract); the host relays it over an
 * AUTHENTICATED transport it owns, and hands the result back in-band. Two
 * invariants mirror the reader:
 *
 *  - the relay NEVER throws into the sandbox bridge: allowlist miss,
 *    transport failure, and un-narrowable answers all collapse to an
 *    in-band `isError` result the card can display;
 *  - runtime re-narrowing, not trust: transports are host-supplied and the
 *    upstream answer is wire data — every content arm is re-checked before
 *    it crosses into the sandbox.
 */

/** The wire arms a relay hands back to the sandbox — re-narrowed, never trusted. */
export type McpToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string } & (
        | { text: string }
        | { blob: string }
      );
    };

/**
 * `structuredContent` is protocol-open by design (the MCP spec types it as
 * an arbitrary JSON object) — the index signature is the honest wire type,
 * not an erasure of a known shape.
 */
export type McpToolStructuredContent = {
  [key: string]: unknown;
};

/**
 * The SEP-1865 CallToolResult surface a host hands back to the sandbox.
 * A `type` alias, deliberately: the MCP SDK's own result types carry Zod
 * passthrough index signatures, and only type aliases (never interfaces)
 * get the implicit index signature that makes this assignable to them.
 */
export type McpToolCallResult = {
  content: McpToolCallContent[];
  isError?: boolean;
  structuredContent?: McpToolStructuredContent;
};

/**
 * The runtime tools a card sandbox may RELAY over `tools/call` — the
 * client-side twin of the server allowlist (defense in depth: the proxy
 * enforces it again). Exactly ggui's iframe-runtime surface, all declared
 * `_meta.ui.visibility: ['app']` (never model-callable):
 *
 *  - `ggui_runtime_submit_action` — the user's gesture (the SEMANTIC one);
 *  - `ggui_runtime_refresh_ws_token` — live-channel credential refresh
 *    (the wsToken TTL is 180 s; without the relay a view on SSE/polling
 *    dies at that mark — guuey#220);
 *  - `ggui_runtime_pull` — the host-relayed polling rung where the
 *    sandbox's own transports are blocked (bridge-pull, terminal rung).
 *
 * Two of these are transport plumbing whose arguments are opaque runtime
 * state — see {@link UI_SEMANTIC_ACTION_TOOLS} for the ONLY set a host may
 * treat as "the user did something".
 */
export const UI_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "ggui_runtime_submit_action",
  "ggui_runtime_refresh_ws_token",
  "ggui_runtime_pull",
]);

/**
 * The strict subset of {@link UI_ACTION_TOOLS} that carries a USER gesture —
 * the only calls a host may project into user-facing affordances (composer
 * staging, "the user selected X" copy, telemetry as intent). Every other
 * relayed tool is runtime plumbing whose payload must NEVER reach the user
 * verbatim (guuey#215/#218: a staged `sessionId …` was exactly that leak).
 * A tool that is relayable is NOT thereby semantic; a host that widens
 * this set is asserting the wire semantics of the new name.
 */
export const UI_SEMANTIC_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "ggui_runtime_submit_action",
]);

/** The in-band answer for anything the relay cannot (or will not) do. */
export const UI_ACTION_UNAVAILABLE_TEXT =
  "This action isn't available right now.";

/**
 * The in-band `isError` result for an action that cannot be performed —
 * the relay's own refusals use it, and `attachViewHost` posts it when an
 * embedder-supplied relay hook rejects (the view is always answered).
 */
export function unavailableToolCallResult(): McpToolCallResult {
  return {
    content: [{ type: "text", text: UI_ACTION_UNAVAILABLE_TEXT }],
    isError: true,
  };
}

function isJsonObjectLike(value: unknown): value is McpToolStructuredContent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asContentArm(value: unknown): McpToolCallContent | undefined {
  if (!isJsonObjectLike(value)) return undefined;
  const type = value["type"];
  if (type === "text" && typeof value["text"] === "string") {
    return { type: "text", text: value["text"] };
  }
  if (
    type === "image" &&
    typeof value["data"] === "string" &&
    typeof value["mimeType"] === "string"
  ) {
    return { type: "image", data: value["data"], mimeType: value["mimeType"] };
  }
  if (type === "resource" && isJsonObjectLike(value["resource"])) {
    const res = value["resource"];
    if (typeof res["uri"] !== "string") return undefined;
    const mimeType =
      typeof res["mimeType"] === "string" ? { mimeType: res["mimeType"] } : {};
    if (typeof res["text"] === "string") {
      return { type: "resource", resource: { uri: res["uri"], ...mimeType, text: res["text"] } };
    }
    if (typeof res["blob"] === "string") {
      return { type: "resource", resource: { uri: res["uri"], ...mimeType, blob: res["blob"] } };
    }
  }
  return undefined;
}

/**
 * Narrow an untrusted `tools/call` answer to the arms the sandbox may see.
 * Unknown content arms are DROPPED (never forwarded opaque); a value that
 * is not result-shaped at all is `undefined` (the relay answers in-band).
 */
export function asToolCallResult(value: unknown): McpToolCallResult | undefined {
  if (!isJsonObjectLike(value)) return undefined;
  const rawContent = value["content"];
  if (!Array.isArray(rawContent)) return undefined;
  const content: McpToolCallContent[] = [];
  for (const entry of rawContent) {
    const arm = asContentArm(entry);
    if (arm) content.push(arm);
  }
  return {
    content,
    ...(value["isError"] === true ? { isError: true } : {}),
    ...(isJsonObjectLike(value["structuredContent"])
      ? { structuredContent: value["structuredContent"] }
      : {}),
  };
}

/** The host-supplied transport {@link createMcpUiActionRelay} assembles over. */
export interface CreateMcpUiActionRelayDeps {
  /**
   * One `tools/call` bound to the mounted card's locator `uri` over the
   * host's authenticated channel. Returns the raw result (narrowed here),
   * or `undefined` when the upstream denied/lost the session. Throwing is
   * treated as unavailable.
   */
  callTool: (
    uri: string,
    name: string,
    args: McpToolStructuredContent | undefined,
  ) => Promise<unknown>;
}

/** The request shape a mounted card's `onCallTool` bridge produces. */
export interface UiActionRequest {
  /** The mounted card's persisted `ui://` locator — the action's scope. */
  resourceUri: string;
  name: string;
  arguments?: McpToolStructuredContent;
}

/**
 * Assemble the sandbox-facing action relay from a host transport. The
 * returned function is shaped for an `onCallTool` bridge: it always
 * resolves (never rejects), answering in-band.
 */
export function createMcpUiActionRelay(
  deps: CreateMcpUiActionRelayDeps,
): (request: UiActionRequest) => Promise<McpToolCallResult> {
  return async (request) => {
    if (!UI_ACTION_TOOLS.has(request.name)) return unavailableToolCallResult();
    if (!request.resourceUri.startsWith("ui://")) return unavailableToolCallResult();
    let raw: unknown;
    try {
      raw = await deps.callTool(request.resourceUri, request.name, request.arguments);
    } catch {
      return unavailableToolCallResult(); // transport failure == unavailable, in-band
    }
    if (raw === undefined) return unavailableToolCallResult();
    return asToolCallResult(raw) ?? unavailableToolCallResult();
  };
}
