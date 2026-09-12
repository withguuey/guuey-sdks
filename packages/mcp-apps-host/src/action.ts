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
  /**
   * Fired ONCE when a card locator's `ggui_runtime_pull` circuit OPENS
   * (guuey#1249 item 4) — the live session is unrestorable (N consecutive
   * both-doors-gone pulls). The complement to leg 1's storm-break: the host
   * surfaces a visible "this session ended — start a new chat" state and drops
   * the stale thread, so a tripped circuit is never a silent frozen card.
   * Optional: a host that only wants the storm bounded omits it.
   */
  onSessionUnrestorable?: (resourceUri: string) => void;
}

/** The request shape a mounted card's `onCallTool` bridge produces. */
export interface UiActionRequest {
  /** The mounted card's persisted `ui://` locator — the action's scope. */
  resourceUri: string;
  name: string;
  arguments?: McpToolStructuredContent;
}

/** The host-relayed auto-poll rung (guuey#1235). A dead session's pull is the storm. */
const PULL_TOOL = "ggui_runtime_pull";

/**
 * Consecutive `unavailable` pull results (per card locator) that OPEN the
 * circuit (guuey#1235 leg 1). At the #1233 storm's ~12-18 pulls/min a 3-strike
 * trip bounds the hammer in ~10-15s; a single good pull resets it, so a
 * transient blip never trips.
 */
export const PULL_CIRCUIT_THRESHOLD = 3;

/**
 * Logged ONCE when a locator's pull circuit opens — the bounded-storm marker
 * (sentry's readability ask; the #1233 next-incident is scopeable from it).
 */
export const UI_ACTION_PULL_CIRCUIT_OPEN = "UI_ACTION_PULL_CIRCUIT_OPEN";

/**
 * Assemble the sandbox-facing action relay from a host transport. The
 * returned function is shaped for an `onCallTool` bridge: it always
 * resolves (never rejects), answering in-band.
 *
 * guuey#1235 leg 1 — the `ggui_runtime_pull` CIRCUIT BREAK. A card whose live
 * session died keeps auto-polling on its own interval; each pull `tools/call`
 * 404s at the pod door → `unavailable` → the sandbox polls again, hammering the
 * door indefinitely (the #1233 prod storm: 57+ over 15 min). After
 * {@link PULL_CIRCUIT_THRESHOLD} CONSECUTIVE `unavailable` pull results for a
 * locator, the circuit OPENS: the relay stops calling the transport for that
 * locator's pull (fail-fast, no network) — the server storm is bounded. A
 * single non-`unavailable` pull result CLOSES it (the session recovered). Only
 * the pull rung is counted — a failed user gesture (`submit_action`) or token
 * refresh must never trip the auto-poll break, and never opens another rung.
 *
 * The complement — telling the USER the session is unrestorable so a tripped
 * circuit is not a silent freeze — is the `onSessionUnrestorable` signal
 * (guuey#1249 item 4); this leg only bounds the hammer.
 */
export function createMcpUiActionRelay(
  deps: CreateMcpUiActionRelayDeps,
): (request: UiActionRequest) => Promise<McpToolCallResult> {
  // Per-relay-instance (one card mount). A recovered/absent locator is deleted,
  // so this stays as small as the mounted cards; the mount tears it down.
  const pullFailures = new Map<string, number>();

  const recordPull = (uri: string, unavailable: boolean): void => {
    if (!unavailable) {
      pullFailures.delete(uri); // the session answered → close the circuit
      return;
    }
    const next = (pullFailures.get(uri) ?? 0) + 1;
    pullFailures.set(uri, next);
    if (next === PULL_CIRCUIT_THRESHOLD) {
      // Once, at the trip — not per subsequent short-circuited poll.
      console.warn(UI_ACTION_PULL_CIRCUIT_OPEN, {
        resourceUri: uri,
        consecutiveUnavailable: next,
      });
      // guuey#1249 item 4: tell the host the session is unrestorable so the
      // bounded circuit isn't a silent freeze. A throw from the host callback
      // must never break the relay's never-reject contract.
      try {
        deps.onSessionUnrestorable?.(uri);
      } catch {
        // A host-supplied callback that throws is the host's bug, not the
        // relay's — the storm is already bounded either way.
      }
    }
  };

  return async (request) => {
    if (!UI_ACTION_TOOLS.has(request.name)) return unavailableToolCallResult();
    if (!request.resourceUri.startsWith("ui://")) return unavailableToolCallResult();

    const isPull = request.name === PULL_TOOL;
    // Circuit OPEN for this locator's pull → fail-fast, never touch the door.
    if (isPull && (pullFailures.get(request.resourceUri) ?? 0) >= PULL_CIRCUIT_THRESHOLD) {
      return unavailableToolCallResult();
    }

    let raw: unknown;
    try {
      raw = await deps.callTool(request.resourceUri, request.name, request.arguments);
    } catch {
      if (isPull) recordPull(request.resourceUri, true); // transport failure == unavailable
      return unavailableToolCallResult(); // in-band
    }
    const result = raw === undefined ? undefined : asToolCallResult(raw);
    if (isPull) recordPull(request.resourceUri, result === undefined);
    return result ?? unavailableToolCallResult();
  };
}
