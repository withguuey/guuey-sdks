/**
 * Guuey Worker Protocol v1 — the frozen, versioned types the Router and a Worker
 * exchange. Types ARE the protocol's source of truth (per-language SDKs derive
 * from these). See the north-star design §1.
 *
 *   Router → Worker  (fd 0 / stdin):  ControlMessage  (invoke | shutdown)
 *   Worker → Router  (fd 3):          WorkerEvent      (text | done | error)
 *   stdout (1) + stderr (2):          the builder's own logs — not the protocol.
 */

/** v1 ≡ the worker-facing half of Guuey Router v1 (pinned via `runtime.router`). */
export const PROTOCOL_VERSION = "v1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** A JSON value — the precise parse target for NDJSON control/event lines
 *  (NOT `unknown`: a parsed line has no static shape yet, but it IS JSON). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AuthMode = "anonymous" | "authenticated";
/** Router-vouched end-user identity (the Worker writes zero auth code). */
export interface Identity {
  userId: string;
  authMode: AuthMode;
}
/** The three GuueyFS layer mounts the Worker reads/writes. */
export interface Fs {
  app: string;
  home: string;
  session: string;
}
export interface HistoryMessage {
  role: "user" | "agent";
  text: string;
}
/**
 * One prior-memory record pushed by value on the invoke (§1.4). A minimal,
 * dependency-free projection of the Router's `AgMemoryRecord` — the worker reads
 * only `key`/`value` for its `<thread_memory>` preamble. `value` is required
 * (the fold seeds it); `key` is optional (unkeyed records exist).
 */
export interface PriorMemoryRecord {
  key?: string;
  value: JsonValue;
}
export type StopReason = "end_turn" | "max_turns" | "error";

// ── Router → Worker: the control stream (fd 0) ──────────────────────────────

/** Start a turn. Carries the pushed context (identity, fs, a recent history
 *  window — the full transcript is at `/session/.guuey/history.jsonl`).
 *
 *  `priorMemory`/`priorState` are the §1.4 push-by-value context the worker
 *  renders into its system-prompt preamble (thread memory + working state).
 *  Both optional: an early-thread invoke carries neither. */
export interface Invoke {
  type: "invoke";
  input: string;
  identity: Identity;
  fs: Fs;
  history: HistoryMessage[];
  /** Thread-scoped memory folded from prior turns (the `<thread_memory>` preamble). */
  priorMemory?: PriorMemoryRecord[];
  /** Prior working-state blob carried from the previous turn (the `<working_state>` preamble). */
  priorState?: JsonValue;
  /**
   * Content of the authenticated caller's persistent `MEMORY.md` file —
   * prompted file memory's RECALL half (guueyfs-slice4 spec §4), read
   * Router-side BEFORE this invoke and pushed by value so recall never
   * depends on the model choosing to read a file. DISTINCT from
   * `priorMemory`: that is thread-scoped conversation memory folded from
   * AgJSON (the persistence-fold's `<thread_memory>` push); this is the
   * user's own cross-session, cross-thread memory file at
   * `$GUUEY_HOME_DIR/memories/MEMORY.md`. Absent for an anonymous caller
   * (never read) or an authenticated caller with no memory file yet.
   */
  userMemory?: string;
}
/** Graceful termination (also signalled by stdin EOF). */
export interface Shutdown {
  type: "shutdown";
}
export type ControlMessage = Invoke | Shutdown;

// ── Worker → Router: the event stream (fd 3) ────────────────────────────────

/** Stream a chunk of assistant output. */
export interface TextEvent {
  type: "text";
  text: string;
}
/** Terminal success. `result` is the turn's final text. */
export interface DoneEvent {
  type: "done";
  stopReason: StopReason;
  result: string;
}
/** Terminal failure. */
export interface ErrorEvent {
  type: "error";
  message: string;
}
/**
 * Pass-through carrier for framework-native SDK events (fd-3).
 * The Worker emits these opaquely; the Router dispatches to the matching
 * `@silverprotocol/<framework>` normalizer.
 *
 * `framework` is typed as `string` rather than the `AgentFramework` enum from
 * `@guuey/config` to keep this package dependency-free. The Router validates
 * `framework` against the real enum before dispatching.
 */
export interface NativeEvent {
  readonly type: "native";
  /** The framework whose native event this is — Router picks the normalizer. */
  readonly framework: string;
  /** One native SDK event, opaque JSON; only the Router's normalizer reads it. */
  readonly event: JsonValue;
}
/**
 * Additive-optional in protocol v1 (the SDK-version handshake, model-release
 * playbook §8 item B). A worker MAY emit this once, before any native/turn
 * event, to report its own SDK provenance. The Router treats it as Router-plane
 * ONLY: never forwarded to the SSE client, never fed to a `@silverprotocol/*`
 * normalizer (it is not an AgJSON-eligible event) — just logged + carried into
 * the invoke's completion telemetry. Absence is fully tolerated (older workers
 * that predate this event, or a builder's own `serve()`-based worker that never
 * emits it): the Router simply has no SDK provenance to log for that invoke.
 */
export interface WorkerHelloEvent {
  readonly type: "hello";
  /** The framework this worker runs — matches `NativeEvent.framework`. */
  readonly framework: string;
  /** The SDK package name, e.g. `"@anthropic-ai/claude-agent-sdk"`; `null` when unknown/inapplicable. */
  readonly sdkName: string | null;
  /** The SDK's installed version, resolved at RUNTIME (never a hardcoded literal); `null` when unresolvable. */
  readonly sdkVersion: string | null;
}
export type WorkerEvent = TextEvent | DoneEvent | ErrorEvent | NativeEvent | WorkerHelloEvent;
