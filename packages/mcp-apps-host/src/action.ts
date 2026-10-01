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
 *    sandbox's own transports are blocked (bridge-pull, terminal rung);
 *  - `ggui_runtime_telemetry` — the card's own health events, relayed only
 *    as the closed kind set {@link UI_TELEMETRY_KINDS}, filtered here before
 *    the relay calls the door;
 *  - `ggui_runtime_report_render_failure` — the card telling the server its
 *    own render threw (ggui#1609), relayed only as exactly its five arguments,
 *    each in its rule ({@link isAdmittedRenderFailureReport}), checked here
 *    before the relay calls the door.
 *
 * Every tool here but `ggui_runtime_submit_action` is runtime plumbing whose
 * arguments are opaque runtime state — see {@link UI_SEMANTIC_ACTION_TOOLS}
 * for the ONLY set a host may treat as "the user did something".
 */
export const UI_ACTION_TOOLS: ReadonlySet<string> = new Set([
  "ggui_runtime_submit_action",
  "ggui_runtime_refresh_ws_token",
  "ggui_runtime_pull",
  "ggui_runtime_telemetry",
  "ggui_runtime_report_render_failure",
]);

/** The card-health telemetry tool. Never a user gesture. */
export const UI_TELEMETRY_TOOL = "ggui_runtime_telemetry";

/**
 * What an admitted telemetry kind may carry as `detail`: nothing (`none`), or
 * one exact, closed shape with no free text — three booleans (`boot-path`), a
 * transport kind and a boolean (`subscribe`), or a render session id
 * (`render-session-id`).
 */
export type UiTelemetryDetailRule = "none" | "boot-path" | "subscribe" | "render-session-id";

/**
 * The closed set of health-event kinds a card may report through the relay:
 * event names and ggui's own ids only, no free text and no user identity.
 * Exact strings, never a prefix. The server doors admit exactly the same set
 * and refuse a whole call that carries anything else; this twin filters
 * events before the door, so a conforming host never sends a refusable call.
 */
export const UI_TELEMETRY_KINDS: ReadonlyMap<string, UiTelemetryDetailRule> = new Map<
  string,
  UiTelemetryDetailRule
>([
  ["boot.path", "boot-path"],
  ["boot.static_only_no_bridge", "none"],
  ["status.connecting", "none"],
  ["status.reconnecting", "none"],
  ["status.connected", "none"],
  ["status.disconnected", "none"],
  ["subscribe.resolved", "subscribe"],
  ["doorbell.ring", "render-session-id"],
]);

/** The per-call event cap the doors enforce. */
export const MAX_UI_TELEMETRY_EVENTS = 40;

/** A render session id as ggui's hosted service mints it: `render_<uuid>`. */
const RENDER_SESSION_ID_RE = /^render_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBSCRIBE_TRANSPORT_KINDS: ReadonlySet<string> = new Set(["ws", "sse", "polling"]);

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: { [key: string]: unknown }, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

/** The detail parsed as JSON, or `undefined` when it is not JSON (the event is then dropped). */
function parsedJson(detail: string): unknown {
  try {
    return JSON.parse(detail);
  } catch {
    return undefined;
  }
}

function telemetryDetailAdmitted(rule: UiTelemetryDetailRule, detail: unknown): boolean {
  if (detail === undefined) return true;
  if (typeof detail !== "string") return false;
  switch (rule) {
    case "none":
      return false;
    case "render-session-id":
      return RENDER_SESSION_ID_RE.test(detail);
    case "boot-path": {
      const v = parsedJson(detail);
      return (
        isPlainObject(v) &&
        hasExactlyKeys(v, ["hasStaticContent", "hasLiveTrio", "bridgeCapable"]) &&
        typeof v["hasStaticContent"] === "boolean" &&
        typeof v["hasLiveTrio"] === "boolean" &&
        typeof v["bridgeCapable"] === "boolean"
      );
    }
    case "subscribe": {
      const v = parsedJson(detail);
      return (
        isPlainObject(v) &&
        hasExactlyKeys(v, ["kind", "hasAck"]) &&
        typeof v["kind"] === "string" &&
        SUBSCRIBE_TRANSPORT_KINDS.has(v["kind"]) &&
        typeof v["hasAck"] === "boolean"
      );
    }
  }
}

/** One event the host will relay: its keys are exactly `at`, `kind` and an admitted `detail`. */
function admittedTelemetryEvent(event: unknown): McpToolStructuredContent | undefined {
  if (!isPlainObject(event)) return undefined;
  if (Object.keys(event).some((k) => k !== "at" && k !== "kind" && k !== "detail")) return undefined;
  const at = event["at"];
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
  const kind = event["kind"];
  const rule = typeof kind === "string" ? UI_TELEMETRY_KINDS.get(kind) : undefined;
  if (rule === undefined || !telemetryDetailAdmitted(rule, event["detail"])) return undefined;
  return event;
}

/**
 * The telemetry call the host relays: the card's `sessionId` (when it is a
 * string) and only the admitted events, oldest first, at most
 * {@link MAX_UI_TELEMETRY_EVENTS}. Whole events are dropped, never edited.
 * `undefined` when nothing is left to relay.
 */
export function admittedTelemetryArguments(
  args: McpToolStructuredContent | undefined,
): McpToolStructuredContent | undefined {
  if (args === undefined || !Array.isArray(args["events"])) return undefined;
  const events: McpToolStructuredContent[] = [];
  for (const event of args["events"]) {
    const admitted = admittedTelemetryEvent(event);
    if (admitted !== undefined) events.push(admitted);
  }
  if (events.length === 0) return undefined;
  const sessionId = args["sessionId"];
  return {
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    events: events.slice(-MAX_UI_TELEMETRY_EVENTS),
  };
}

/** The local answer when a telemetry call has nothing admitted to relay: ggui's own `{ok: true}` shape. */
function telemetryNothingToRelayResult(): McpToolCallResult {
  return { content: [], structuredContent: { ok: true } };
}

/**
 * The render-failure report tool (ggui#1609): the card tells the server its own
 * render threw. Relayed, never a user gesture: it is not in
 * {@link UI_SEMANTIC_ACTION_TOOLS}.
 */
export const UI_RENDER_FAILURE_TOOL = "ggui_runtime_report_render_failure";

/** The two render phases a report names. */
export const UI_RENDER_FAILURE_PHASES = ["mount", "update"] as const;

/** A render phase a report names: `mount` or `update`. */
export type UiRenderFailurePhase = (typeof UI_RENDER_FAILURE_PHASES)[number];

/** The longest `sessionId` or `appId` the doors admit in a report. */
export const MAX_UI_RENDER_FAILURE_ID_CHARS = 256;

/** The largest `catches` a report may carry: an integer, 0 to this, inclusive. */
export const MAX_UI_RENDER_FAILURE_CATCHES = 100;

/** A thrown error's name: a letter, then at most 63 of letters, digits, `_`, `$` and `.`. */
const RENDER_FAILURE_ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_$.]{0,63}$/;

/**
 * The arguments of a render-failure report: exactly these five. A type alias,
 * not an interface: only an alias is assignable to the index-signature
 * {@link McpToolStructuredContent} the relay's transport takes.
 */
export type UiRenderFailureReportArguments = {
  readonly sessionId: string;
  readonly appId: string;
  readonly phase: UiRenderFailurePhase;
  readonly errorName: string;
  readonly catches: number;
};

function isRenderFailureId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_UI_RENDER_FAILURE_ID_CHARS;
}

function isRenderFailurePhase(value: unknown): value is UiRenderFailurePhase {
  return UI_RENDER_FAILURE_PHASES.some((phase) => phase === value);
}

function isRenderFailureErrorName(value: unknown): value is string {
  return typeof value === "string" && RENDER_FAILURE_ERROR_NAME_RE.test(value);
}

function isRenderFailureCatches(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UI_RENDER_FAILURE_CATCHES;
}

/** Each argument's rule, keyed by the argument: exactly the five of {@link UiRenderFailureReportArguments}. */
const RENDER_FAILURE_FIELDS: {
  readonly [K in keyof UiRenderFailureReportArguments]-?: (value: unknown) => value is UiRenderFailureReportArguments[K];
} = {
  sessionId: isRenderFailureId,
  appId: isRenderFailureId,
  phase: isRenderFailurePhase,
  errorName: isRenderFailureErrorName,
  catches: isRenderFailureCatches,
};

/**
 * Whether a render-failure report is one the server doors admit: exactly the
 * five arguments, each in its rule. The doors refuse a whole call that carries
 * an unknown key, lacks one, or holds a value outside its rule; this twin
 * checks the same before the door, so a conforming host never sends a
 * refusable report. Nothing is stripped or rewritten: an admitted report is
 * relayed as the card sent it.
 */
export function isAdmittedRenderFailureReport(
  args: McpToolStructuredContent | undefined,
): args is UiRenderFailureReportArguments {
  if (args === undefined) return false;
  if (Object.keys(args).some((key) => !Object.prototype.hasOwnProperty.call(RENDER_FAILURE_FIELDS, key))) return false;
  return Object.entries(RENDER_FAILURE_FIELDS).every(
    ([key, admitted]) => Object.prototype.hasOwnProperty.call(args, key) && admitted(args[key]),
  );
}

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
   *
   * Once per trip: it fires again only after {@link onSessionRestored} has
   * cleared an earlier verdict for the same locator and the circuit trips anew.
   */
  onSessionUnrestorable?: (resourceUri: string) => void;
  /**
   * Fired when a locator whose pull circuit OPENED is seen live again on the
   * pull rung itself, so the host can withdraw the "session ended" state it
   * showed. Wiring it is what lets an open circuit recover in place at all:
   * without it the circuit stays open for the mount (recovery is a fresh
   * mount), exactly as a host that wires only {@link onSessionUnrestorable}
   * expects.
   *
   * The recovery is evidence on the channel that tripped: a successful
   * `ggui_runtime_refresh_ws_token` for the locator HALF-OPENS the circuit,
   * which lets the view's next pull through as a single probe. A probe that
   * the session answers with a result closes the circuit and fires this, once
   * per close; a probe that fails, or that the door answers with an in-band
   * `isError` refusal of any kind, leaves it open, and the host hears nothing
   * new (it already holds the verdict). A refusal is a door that answered, not
   * a session that did: an ended session's pull is answered exactly that way.
   * A token refresh alone never reverses it: the token channel can work while
   * pulls still fail.
   */
  onSessionRestored?: (resourceUri: string) => void;
}

/** The request shape a mounted card's `onCallTool` bridge produces. */
export interface UiActionRequest {
  /** The mounted card's persisted `ui://` locator — the action's scope. */
  resourceUri: string;
  name: string;
  arguments?: McpToolStructuredContent;
}

/**
 * The render session a `ui://ggui/render/<sessionId>/<hash>` locator names,
 * or `undefined` for any other locator shape (guuey#2031).
 *
 * A MIRROR of the rule both action doors bind a card action's session with
 * (the server's `gguiRenderSessionId`, held equal to this one by the server
 * side's `ui-action-policy.sync.test.ts`). The locator is the host's own (the
 * mount's persisted `resourceUri`), never the card's arguments, so a host that
 * decides a tap's session with it decides exactly what the doors decide.
 */
export function gguiRenderSessionId(uri: string): string | undefined {
  const prefix = "ui://ggui/render/";
  if (!uri.startsWith(prefix)) return undefined;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  return rest.slice(0, slash);
}

/** The host-relayed auto-poll rung (guuey#1235). A dead session's pull is the storm. */
const PULL_TOOL = "ggui_runtime_pull";

/** The live-channel token refresh: a success half-opens a tripped locator for a host that can hear a restore. */
const REFRESH_WS_TOKEN_TOOL = "ggui_runtime_refresh_ws_token";

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
 * The SYMBOL is the handle code and tests grep; its VALUE is the sentence a
 * builder reads in their own site's console (guuey#1375) — our one prefix,
 * then what happened and what follows, never an internal token. It says
 * exactly what the circuit does: the relay stops pulling for that locator,
 * the host is told the session is unrestorable (`onSessionUnrestorable`),
 * and nothing retries unattended.
 */
export const UI_ACTION_PULL_CIRCUIT_OPEN =
  "[guuey] card updates stopped — the session behind this card could not be restored; the widget reports it, and a new conversation starts fresh";

/**
 * Logged when an open circuit closes again: the probe pull a successful token
 * refresh let through was answered with a result, not a refusal, and the host
 * was told (`onSessionRestored`). It can only happen for a host that wires
 * that signal.
 */
export const UI_ACTION_PULL_CIRCUIT_CLOSED =
  "[guuey] card updates resumed — the session behind this card answered again";

/**
 * Logged when a host's `onSessionUnrestorable` or `onSessionRestored`
 * callback throws. The relay never rejects into the card, so it goes on; this
 * line is the page's only trace that its own "session ended" state may now be
 * out of step with the card. It names the callback and the error's `name`,
 * never the error's text, which is the host's and can carry anything.
 */
export const UI_ACTION_HOST_CALLBACK_THREW =
  "[guuey] the page's card-session handler threw — the card went on, but the page may not show its current state";

/**
 * What one relayed pull tells the circuit:
 *
 *  - `unavailable` — no answer at all: the transport threw, the door denied or
 *    lost the session, or the answer was not result-shaped;
 *  - `refused` — the door answered with an in-band `isError` refusal (both
 *    action doors relay ggui's refusals as a 200 with the result body, so an
 *    ended session's pull lands here, not in `unavailable`);
 *  - `live` — the session answered the pull with a result.
 */
type PullOutcome = "unavailable" | "refused" | "live";

function pullOutcome(result: McpToolCallResult | undefined): PullOutcome {
  if (result === undefined) return "unavailable";
  return result.isError === true ? "refused" : "live";
}

/** Call a host's session callback; a throw is logged by name and never escapes the relay. */
function callHostCallback(
  callback: "onSessionUnrestorable" | "onSessionRestored",
  fn: ((resourceUri: string) => void) | undefined,
  resourceUri: string,
): void {
  try {
    fn?.(resourceUri);
  } catch (err) {
    console.warn(UI_ACTION_HOST_CALLBACK_THREW, {
      callback,
      resourceUri,
      name: err instanceof Error ? err.name : typeof err,
    });
  }
}

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
 * locator's pull (fail-fast, no network) — the server storm is bounded. While
 * it is still closed, any answered pull (a result or an in-band refusal) ends
 * the run of `unavailable` ones, so a transient blip never trips it. Only
 * the pull rung is counted — a failed user gesture (`submit_action`) or token
 * refresh must never trip the auto-poll break, and never opens another rung.
 *
 * The complement — telling the USER the session is unrestorable so a tripped
 * circuit is not a silent freeze — is the `onSessionUnrestorable` signal
 * (guuey#1249 item 4); this leg only bounds the hammer.
 *
 * An OPEN circuit is terminal for the mount unless the host wires
 * `onSessionRestored`. Then a successful `ggui_runtime_refresh_ws_token` for
 * the locator HALF-OPENS it: the next pull goes through as one probe, and only
 * a probe the session answers with a result closes it (see
 * `onSessionRestored`). Withdrawing a verdict the user can see takes more than
 * not issuing one: an in-band refusal never closes an OPEN circuit, whatever
 * its code (guuey#1978). Settled for every refusal rather than ggui's
 * `session_not_found` alone because a refusal of any code is no evidence the
 * session is live, the token refresh that arms the probe is held to the same
 * bar, and a circuit wrongly kept open costs one more refresh-and-probe cycle,
 * while one wrongly closed tells the user an ended session is back.
 */
export function createMcpUiActionRelay(
  deps: CreateMcpUiActionRelayDeps,
): (request: UiActionRequest) => Promise<McpToolCallResult> {
  // Per-relay-instance (one card mount). A recovered/absent locator is deleted,
  // so this stays as small as the mounted cards; the mount tears it down.
  const pullFailures = new Map<string, number>();
  // Open locators a successful token refresh has half-opened: the next pull is
  // let through as the probe. Only ever filled when the host wires the restore.
  const halfOpen = new Set<string>();

  const isOpen = (uri: string): boolean => (pullFailures.get(uri) ?? 0) >= PULL_CIRCUIT_THRESHOLD;

  const recordPull = (uri: string, outcome: PullOutcome): void => {
    if (outcome === "refused") {
      // A closed circuit: the door answered, so the run of unavailable pulls
      // ends, as it always has. An OPEN one (the half-open probe, or a pull in
      // flight across the trip): a refusal is not the session answering, so it
      // stays open and the host hears nothing new (guuey#1978).
      if (!isOpen(uri)) pullFailures.delete(uri);
      return;
    }
    if (outcome === "live") {
      const wasOpen = isOpen(uri);
      pullFailures.delete(uri); // the session answered → close the circuit
      if (wasOpen) {
        console.warn(UI_ACTION_PULL_CIRCUIT_CLOSED, { resourceUri: uri });
        // The circuit is closed either way: a throwing host callback is logged, never rethrown.
        callHostCallback("onSessionRestored", deps.onSessionRestored, uri);
      }
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
      // The storm is bounded either way: a throwing host callback is logged, never rethrown.
      callHostCallback("onSessionUnrestorable", deps.onSessionUnrestorable, uri);
    }
  };

  return async (request) => {
    if (!UI_ACTION_TOOLS.has(request.name)) return unavailableToolCallResult();
    if (!request.resourceUri.startsWith("ui://")) return unavailableToolCallResult();

    // The card's health events: only the admitted kinds reach the door, and a
    // door that refuses the tool (an older server) answers in-band like any
    // other failure. Telemetry never touches the pull circuit.
    let callArguments = request.arguments;
    if (request.name === UI_TELEMETRY_TOOL) {
      callArguments = admittedTelemetryArguments(request.arguments);
      if (callArguments === undefined) return telemetryNothingToRelayResult();
    }
    // A render-failure report the doors would refuse never reaches them: it is
    // answered in-band like any other unavailable action. The card acts on no
    // answer, and the report never touches the pull circuit.
    if (request.name === UI_RENDER_FAILURE_TOOL && !isAdmittedRenderFailureReport(request.arguments)) {
      return unavailableToolCallResult();
    }

    const isPull = request.name === PULL_TOOL;
    // Circuit OPEN for this locator's pull → fail-fast, never touch the door,
    // unless a token refresh half-opened it: then this one pull is the probe.
    if (isPull && isOpen(request.resourceUri)) {
      if (!halfOpen.delete(request.resourceUri)) return unavailableToolCallResult();
    }

    let raw: unknown;
    try {
      raw = await deps.callTool(request.resourceUri, request.name, callArguments);
    } catch {
      if (isPull) recordPull(request.resourceUri, "unavailable"); // transport failure == unavailable
      return unavailableToolCallResult(); // in-band
    }
    const result = raw === undefined ? undefined : asToolCallResult(raw);
    if (isPull) recordPull(request.resourceUri, pullOutcome(result));
    // A refresh the session granted is fresh evidence it is live, but on the
    // token channel, not the pull channel that tripped: it half-opens, and the
    // probe pull decides. Only for a host that can withdraw its verdict.
    if (
      request.name === REFRESH_WS_TOKEN_TOOL &&
      deps.onSessionRestored !== undefined &&
      result !== undefined &&
      result.isError !== true &&
      isOpen(request.resourceUri)
    ) {
      halfOpen.add(request.resourceUri);
    }
    return result ?? unavailableToolCallResult();
  };
}
