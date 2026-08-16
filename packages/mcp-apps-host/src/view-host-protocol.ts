/**
 * The Host half of the MCP Apps (SEP-1865) App handshake, as a PURE state
 * machine — message in, `{state, effects}` out, zero DOM (guuey#186 Gap 1).
 *
 * ## Why the view hangs without this
 *
 * A spec-following App (ggui's iframe-runtime included) opens with
 * `ui/initialize` posted to its parent and BLOCKS — the handshake runs
 * before the view reads any seeded boot data, so a frame whose parent
 * never answers stays blank forever. `toolResultViewMount` prepares the
 * document; THIS module answers the document. The two halves together are
 * the Host role the package is named for.
 *
 * ## Why a pure machine
 *
 * Only a real browser runs the postMessage/sandbox physics, but the
 * publish gate (guuey-sdks mirror CI) is Node-only — the exact blind spot
 * that let the missing-host gap ship (mount-material assertions run in
 * Node; nothing ran the negotiation). So the protocol logic lives here,
 * exhaustively unit-tested against scripted message sequences, and the DOM
 * glue in `view-host.ts` stays thin enough to carry no decisions. Even the
 * negotiation timeout is a machine INPUT ({@link viewHostElapsed}), not a
 * timer here.
 *
 * ## Spec posture
 *
 * Types and method names come from `@modelcontextprotocol/ext-apps` — the
 * SEP-1865 surface itself, someone else's frozen contract. Zero ggui
 * imports, deliberately (guuey#123): this host answers ANY spec-following
 * view. (The ggui vendor arm that used to live beside it in
 * `ggui-render.ts` retired 2026-08-16 — guuey#209; that module is now
 * deprecated re-exports only.)
 */
import {
  INITIALIZE_METHOD,
  LATEST_PROTOCOL_VERSION,
  RESOURCE_TEARDOWN_METHOD,
  SIZE_CHANGED_METHOD,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiInitializeResult,
} from "@modelcontextprotocol/ext-apps";
import type { McpToolStructuredContent } from "./action.js";
import type { McpResourceReadResult } from "./reader.js";

/**
 * The host identity in the initialize result — structurally the spec's
 * `Implementation` (which the ext-apps root does not re-export), narrowed
 * to the two fields a host must supply.
 */
export interface ViewHostInfo {
  name: string;
  version: string;
}

/** JSON-RPC `method not found` — the spec's code, not an invented one. */
const METHOD_NOT_SUPPORTED = -32601;

/** The standard MCP method a view uses to reach host-proxied tools. */
export const TOOLS_CALL_METHOD = "tools/call";

/**
 * The standard MCP method a view uses to read host-proxied resources —
 * `ReadResourceRequest` in the spec's App→Host request union
 * (`@modelcontextprotocol/ext-apps` `AppRequest`). A local constant, same
 * as {@link TOOLS_CALL_METHOD}: the string is MCP-core vocabulary the
 * ext-apps root does not re-export, and this package deliberately carries
 * no `@modelcontextprotocol/sdk` dependency.
 */
export const RESOURCES_READ_METHOD = "resources/read";

/**
 * MCP's `Resource not found` JSON-RPC code — the one answer for a miss, a
 * transport deny, AND a relay failure (deny == miss: the reader discipline,
 * `reader.ts` — the view gets no oracle for which locators resolve).
 */
const RESOURCE_NOT_FOUND = -32002;

/** A JSON-RPC id as the wire allows it. */
export type ViewRequestId = number | string;

/** The messages this host posts INTO the view frame. */
export interface ViewHostOutbound {
  jsonrpc: "2.0";
  id?: ViewRequestId;
  method?: string;
  params?: { [key: string]: unknown };
  result?: { [key: string]: unknown };
  error?: { code: number; message: string };
}

/**
 * Where the negotiation stands, from the host's side of the boundary.
 *
 *  - `"negotiating"` — attached; no `ui/initialize` seen yet. A plain-HTML
 *    inline card may stay here forever, legitimately: the handshake is how
 *    a spec App boots, not an obligation on arbitrary tenant HTML.
 *  - `"connected"` — `ui/initialize` was answered. The view owns its own
 *    pixels (and its own failures) from here on.
 *  - `"no-handshake"` — the caller declared the negotiation window over
 *    ({@link viewHostElapsed}) before any `ui/initialize` arrived. What
 *    that MEANS depends on the mount channel and is the renderer's call:
 *    a `"ggui"` shell always handshakes, so this phase is a boot failure
 *    there; an `"inline"` card may simply not be an App.
 *
 * A renderer binds to this — the failure mode must be a labeled state,
 * never a blank page (guuey#186 audit).
 */
export type ViewHostPhase = "negotiating" | "connected" | "no-handshake";

/** The machine's whole state. Immutable — every transition returns a new one. */
export interface ViewHostState {
  phase: ViewHostPhase;
  /** `ui/notifications/initialized` seen (the App's post-handshake ack). */
  initializedSeen: boolean;
}

export function initialViewHostState(): ViewHostState {
  return { phase: "negotiating", initializedSeen: false };
}

/**
 * What the glue must DO after a transition. Effects are data so the machine
 * stays synchronous and Node-testable; the glue performs them.
 */
export type ViewHostEffect =
  | { kind: "respond"; message: ViewHostOutbound }
  | {
      /**
       * A `tools/call` the config accepted for relaying. The glue runs the
       * (async) relay hook and posts {@link toolCallResponse} with the
       * result. Only ever emitted when {@link ViewHostBehavior.toolRelay}
       * is true — with no relay wired, the machine refuses the call
       * in-band instead (an honest `method_not_supported`).
       */
      kind: "relay-tool-call";
      id: ViewRequestId;
      name: string;
      arguments?: McpToolStructuredContent;
    }
  | {
      /**
       * A `resources/read` the config accepted for relaying (spec surface:
       * `ReadResourceRequest` rides the App→Host union, and the matching
       * advertisement is `hostCapabilities.serverResources`). The glue runs
       * the read hook and posts {@link resourceReadResponse}. Only emitted
       * when {@link ViewHostBehavior.resourceRelay} is true — unwired, the
       * machine refuses in-band like every other unsupported request.
       */
      kind: "relay-resource-read";
      id: ViewRequestId;
      uri: string;
    }
  | {
      /**
       * The view reported its content size (`ui/notifications/size-changed`
       * — spec notification, App → Host). At least one of the two fields is
       * a finite number; a notification carrying neither is consumed
       * silently instead. The glue forwards this to the embedder
       * ({@link AttachViewHostConfig.onSizeChanged} in `view-host.ts`) —
       * whether/how to resize the frame is the embedder's layout decision,
       * never the machine's.
       */
      kind: "size-changed";
      width?: number;
      height?: number;
    };

/**
 * The host identity/behavior the machine answers with. Everything here is
 * explicit config — the machine assumes nothing about the embedder.
 */
export interface ViewHostBehavior {
  hostInfo: ViewHostInfo;
  /**
   * The capabilities to advertise. Empty is a correct, honest default for
   * views that ride their own live channel (ggui views do — they boot from
   * their seeded envelope and talk to their pod directly, so the host's
   * whole job is unblocking the handshake). Advertise ONLY what the
   * embedder actually implements: a capability the host does not honor
   * makes the view attribute later failures to the wrong layer.
   */
  hostCapabilities: McpUiHostCapabilities;
  /** The context handed to the view in the initialize result. */
  hostContext: McpUiHostContext;
  /** Whether a `tools/call` relay hook is wired (see `view-host.ts`). */
  toolRelay: boolean;
  /** Whether a `resources/read` relay hook is wired (see `view-host.ts`). */
  resourceRelay: boolean;
}

/** The result of feeding one inbound frame (or the timeout) to the machine. */
export interface ViewHostTransition {
  state: ViewHostState;
  effects: ViewHostEffect[];
}

interface InboundEnvelope {
  id?: ViewRequestId;
  method: string;
  params?: { [key: string]: unknown };
}

/** Plain-object narrowing, same idiom as `action.ts`'s `isJsonObjectLike`. */
function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow untrusted postMessage data to a JSON-RPC envelope this host could
 * answer. Anything else — other windows' chatter, the view's own non-RPC
 * messages — is silently not ours (`undefined`), NOT an error: a shared
 * `message` listener hears the whole page.
 */
function asInboundEnvelope(data: unknown): InboundEnvelope | undefined {
  if (!isPlainObject(data)) return undefined;
  if (data["jsonrpc"] !== "2.0") return undefined;
  const method = data["method"];
  if (typeof method !== "string") return undefined;
  const id = data["id"];
  const params = data["params"];
  return {
    ...(typeof id === "number" || typeof id === "string" ? { id } : {}),
    method,
    ...(isPlainObject(params) ? { params } : {}),
  };
}

/** The spec-canonical answer to `ui/initialize`. Exported for the glue/tests. */
export function initializeResult(
  behavior: ViewHostBehavior,
  requestedProtocolVersion: unknown,
): McpUiInitializeResult {
  // Echo the version the view asked for when it names one — the view is
  // the side with a fixed runtime; the host has no version-specific
  // behavior to defend. Absent/malformed, answer with the spec's latest.
  const protocolVersion =
    typeof requestedProtocolVersion === "string" && requestedProtocolVersion.length > 0
      ? requestedProtocolVersion
      : LATEST_PROTOCOL_VERSION;
  return {
    protocolVersion,
    hostInfo: behavior.hostInfo,
    hostCapabilities: behavior.hostCapabilities,
    hostContext: behavior.hostContext,
  };
}

/** Build the in-band response for a relayed `tools/call`'s settled result. */
export function toolCallResponse(
  id: ViewRequestId,
  result: { [key: string]: unknown },
): ViewHostOutbound {
  return { jsonrpc: "2.0", id, result };
}

/**
 * Build the in-band response for a relayed `resources/read`. An entry
 * becomes the spec's `ReadResourceResult` (`contents: [entry]`); `undefined`
 * — a miss, a deny, or a relay failure alike — becomes the one
 * `Resource not found` error (deny == miss, {@link RESOURCE_NOT_FOUND}).
 */
export function resourceReadResponse(
  id: ViewRequestId,
  entry: McpResourceReadResult | undefined,
): ViewHostOutbound {
  if (entry === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: RESOURCE_NOT_FOUND, message: "resource unavailable" },
    };
  }
  return { jsonrpc: "2.0", id, result: { contents: [entry] } };
}

/**
 * The spec-mannered farewell a detaching host posts (`ui/resource-teardown`).
 * Sent WITHOUT an id — a host that is tearing the frame down cannot await a
 * response, and an id-less JSON-RPC message is a notification the view may
 * use for cleanup or ignore.
 */
export function teardownMessage(): ViewHostOutbound {
  return { jsonrpc: "2.0", method: RESOURCE_TEARDOWN_METHOD, params: {} };
}

/**
 * Feed one inbound postMessage payload to the machine.
 *
 * The contract, exactly:
 *  - non-RPC data → ignored (not ours);
 *  - notifications (no id) → consumed silently, JSON-RPC-correctly; the
 *    `ui/notifications/initialized` ack is remembered on the state;
 *  - `ui/initialize` → answered spec-canonically; phase → `"connected"`
 *    (also from `"no-handshake"` — a late handshake still gets answered:
 *    the timeout labels a state, it does not close the door);
 *  - `tools/call` with a relay wired → `relay-tool-call` effect;
 *  - every other REQUEST → `method_not_supported`, honestly.
 */
export function viewHostReceive(
  state: ViewHostState,
  behavior: ViewHostBehavior,
  data: unknown,
): ViewHostTransition {
  const req = asInboundEnvelope(data);
  if (req === undefined) return { state, effects: [] };

  if (req.id === undefined) {
    // A notification. Track the one the handshake defines, surface the one
    // the embedder may act on; consume the rest.
    if (req.method === "ui/notifications/initialized" && !state.initializedSeen) {
      return { state: { ...state, initializedSeen: true }, effects: [] };
    }
    if (req.method === SIZE_CHANGED_METHOD) {
      const width = req.params?.["width"];
      const height = req.params?.["height"];
      const validWidth = typeof width === "number" && Number.isFinite(width);
      const validHeight = typeof height === "number" && Number.isFinite(height);
      if (validWidth || validHeight) {
        return {
          state,
          effects: [
            {
              kind: "size-changed",
              ...(validWidth ? { width } : {}),
              ...(validHeight ? { height } : {}),
            },
          ],
        };
      }
    }
    return { state, effects: [] };
  }

  if (req.method === INITIALIZE_METHOD) {
    const result = initializeResult(behavior, req.params?.["protocolVersion"]);
    return {
      state: { ...state, phase: "connected" },
      effects: [{ kind: "respond", message: { jsonrpc: "2.0", id: req.id, result } }],
    };
  }

  if (req.method === TOOLS_CALL_METHOD && behavior.toolRelay) {
    const name = req.params?.["name"];
    if (typeof name === "string") {
      const args = req.params?.["arguments"];
      return {
        state,
        effects: [
          {
            kind: "relay-tool-call",
            id: req.id,
            name,
            ...(isPlainObject(args) ? { arguments: args } : {}),
          },
        ],
      };
    }
    // fall through: a nameless tools/call is not a call we can relay.
  }

  if (req.method === RESOURCES_READ_METHOD && behavior.resourceRelay) {
    const uri = req.params?.["uri"];
    if (typeof uri === "string") {
      return { state, effects: [{ kind: "relay-resource-read", id: req.id, uri }] };
    }
    // fall through: a uri-less read is not a read we can relay.
  }

  const answered = [
    INITIALIZE_METHOD,
    ...(behavior.toolRelay ? [TOOLS_CALL_METHOD] : []),
    ...(behavior.resourceRelay ? [RESOURCES_READ_METHOD] : []),
  ];
  return {
    state,
    effects: [
      {
        kind: "respond",
        message: {
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: METHOD_NOT_SUPPORTED,
            message: `method_not_supported: ${req.method} — this host answers ${answered.join(", ")} only`,
          },
        },
      },
    ],
  };
}

/**
 * Declare the negotiation window over. Meaningful only while
 * `"negotiating"`: a connected view stays connected, and an already-lapsed
 * one stays lapsed. The caller owns the clock — this machine has none.
 */
export function viewHostElapsed(state: ViewHostState): ViewHostState {
  return state.phase === "negotiating" ? { ...state, phase: "no-handshake" } : state;
}
