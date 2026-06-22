/**
 * Guuey Worker Protocol v1 — the frozen, versioned types the Router and a Worker
 * exchange. Types ARE the protocol's source of truth (per-language SDKs derive
 * from these). See the north-star design §1.
 *
 *   Router → Worker  (fd 0 / stdin):  ControlMessage  (invoke | answer | shutdown)
 *   Worker → Router  (fd 3):          WorkerEvent      (text | ask | done | error)
 *   stdout (1) + stderr (2):          the builder's own logs — not the protocol.
 */

/** v1 ≡ the worker-facing half of Guuey Router v1 (pinned via `runtime.router`). */
export const PROTOCOL_VERSION = "v1" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** A JSON value — the precise type for the dynamic `ask.schema` + `answer.value`
 *  (NOT `unknown`: these genuinely have no static shape, but they ARE JSON). */
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
export type StopReason = "end_turn" | "max_turns" | "error";

// ── Router → Worker: the control stream (fd 0) ──────────────────────────────

/** Start a turn. Carries the pushed context (identity, fs, a recent history
 *  window — the full transcript is at `/session/.guuey/history.jsonl`). */
export interface Invoke {
  type: "invoke";
  input: string;
  identity: Identity;
  fs: Fs;
  history: HistoryMessage[];
}
/** The user's response to a prior `ask` (shape defined by that ask's `schema`). */
export interface Answer {
  type: "answer";
  value: JsonValue;
}
/** Graceful termination (also signalled by stdin EOF). */
export interface Shutdown {
  type: "shutdown";
}
export type ControlMessage = Invoke | Answer | Shutdown;

// ── Worker → Router: the event stream (fd 3) ────────────────────────────────

/** Stream a chunk of assistant output. */
export interface TextEvent {
  type: "text";
  text: string;
}
/** Mid-turn human-in-the-loop: pause and request a structured value. The Worker
 *  blocks until an `Answer` arrives. `schema` is the JSON Schema of the expected
 *  answer (UI-agnostic — rich rendering is an MCP concern, not the protocol). */
export interface AskEvent {
  type: "ask";
  prompt: string;
  schema?: JsonValue;
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
export type WorkerEvent = TextEvent | AskEvent | DoneEvent | ErrorEvent;
