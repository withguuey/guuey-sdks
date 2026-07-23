/**
 * Tier-1 typed interpreter: validate one NDJSON control line (Router→Worker, fd
 * 0) into a typed {@link ControlMessage}. Hand-rolled guards keep the package
 * dependency-free. A malformed line throws a clear error (never a silent skip).
 */
import type {
  AuthMode,
  ControlMessage,
  DoneEvent,
  ErrorEvent,
  Fs,
  HistoryMessage,
  Identity,
  Invoke,
  JsonValue,
  NativeEvent,
  PriorMemoryRecord,
  Shutdown,
  StopReason,
  TextEvent,
  WorkerEvent,
  WorkerHelloEvent,
} from "./protocol.js";

export function isInvoke(m: ControlMessage): m is Invoke {
  return m.type === "invoke";
}
export function isShutdown(m: ControlMessage): m is Shutdown {
  return m.type === "shutdown";
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseIdentity(v: JsonValue | undefined): Identity {
  if (!isObject(v) || typeof v.userId !== "string") {
    throw new Error("invoke.identity missing string `userId`");
  }
  const authMode: AuthMode = v.authMode === "authenticated" ? "authenticated" : "anonymous";
  return { userId: v.userId, authMode };
}

function parseFs(v: JsonValue | undefined): Fs {
  if (
    !isObject(v) ||
    typeof v.app !== "string" ||
    typeof v.home !== "string" ||
    typeof v.session !== "string"
  ) {
    throw new Error("invoke.fs missing string `app`/`home`/`session`");
  }
  return { app: v.app, home: v.home, session: v.session };
}

function parseHistory(v: JsonValue | undefined): HistoryMessage[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("invoke.history must be an array");
  return v.map((m) => {
    if (!isObject(m) || typeof m.text !== "string") {
      throw new Error("invoke.history entry missing string `text`");
    }
    return { role: m.role === "agent" ? "agent" : "user", text: m.text };
  });
}

/**
 * Parse the optional `priorMemory` push (§1.4). Lenient by design — a malformed
 * entry (no `value`, or a non-object) is DROPPED rather than throwing, so a
 * stray memory record never fails an otherwise-valid turn. Returns `undefined`
 * when absent or when no entry survives (so the field stays off the Invoke).
 */
function parsePriorMemory(v: JsonValue | undefined): PriorMemoryRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PriorMemoryRecord[] = [];
  for (const entry of v) {
    if (isObject(entry) && "value" in entry) {
      out.push({
        value: entry.value,
        ...(typeof entry.key === "string" ? { key: entry.key } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function parseControl(line: string): ControlMessage {
  let raw: JsonValue;
  try {
    raw = JSON.parse(line) as JsonValue;
  } catch {
    throw new Error(`non-JSON control line: ${line.slice(0, 200)}`);
  }
  if (!isObject(raw)) {
    throw new Error(`control line is not an object: ${line.slice(0, 200)}`);
  }
  switch (raw.type) {
    case "invoke": {
      if (typeof raw.input !== "string") throw new Error("invoke missing string `input`");
      const priorMemory = parsePriorMemory(raw.priorMemory);
      return {
        type: "invoke",
        input: raw.input,
        identity: parseIdentity(raw.identity),
        fs: parseFs(raw.fs),
        history: parseHistory(raw.history),
        // §1.4 push-by-value context — additive, both optional. `priorState` uses
        // a `!== undefined` gate (not truthiness) so a falsy blob (null/0/"") is
        // preserved; `priorMemory` is omitted when empty/absent.
        ...(priorMemory ? { priorMemory } : {}),
        ...(raw.priorState !== undefined ? { priorState: raw.priorState } : {}),
        // memory-mcp prompted memory (spec §4) — DISTINCT from `priorMemory`
        // above (see the `Invoke.userMemory` doc). Omitted when absent/non-string
        // so it never lands on the typed Invoke as `undefined`.
        ...(typeof raw.userMemory === "string" ? { userMemory: raw.userMemory } : {}),
        // memory-mcp T5: the memory-child attachment signal — gates the SAVE
        // instruction (all three frameworks) independent of `userMemory`.
        // Omitted unless a real boolean so it never lands as `undefined`.
        ...(typeof raw.memoryAttached === "boolean" ? { memoryAttached: raw.memoryAttached } : {}),
      };
    }
    case "shutdown":
      return { type: "shutdown" };
    default:
      throw new Error(`unknown control message type: ${String(raw.type)}`);
  }
}

export function isText(e: WorkerEvent): e is TextEvent {
  return e.type === "text";
}
export function isDone(e: WorkerEvent): e is DoneEvent {
  return e.type === "done";
}
export function isError(e: WorkerEvent): e is ErrorEvent {
  return e.type === "error";
}
export function isNative(e: WorkerEvent): e is NativeEvent {
  return e.type === "native";
}
export function isHello(e: WorkerEvent): e is WorkerHelloEvent {
  return e.type === "hello";
}

/**
 * Router-side typed interpreter: validate one NDJSON event line (Worker→Router,
 * fd 3) into a typed {@link WorkerEvent}. Mirror of {@link parseControl}; a
 * malformed line throws (never a silent skip).
 */
export function parseEvent(line: string): WorkerEvent {
  let raw: JsonValue;
  try {
    raw = JSON.parse(line) as JsonValue;
  } catch {
    throw new Error(`non-JSON event line: ${line.slice(0, 200)}`);
  }
  if (!isObject(raw)) {
    throw new Error(`event line is not an object: ${line.slice(0, 200)}`);
  }
  switch (raw.type) {
    case "text": {
      if (typeof raw.text !== "string") throw new Error("text event missing string `text`");
      return { type: "text", text: raw.text };
    }
    case "done": {
      const stopReason: StopReason =
        raw.stopReason === "max_turns" || raw.stopReason === "error" ? raw.stopReason : "end_turn";
      const result = typeof raw.result === "string" ? raw.result : "";
      return { type: "done", stopReason, result };
    }
    case "error": {
      const message = typeof raw.message === "string" ? raw.message : "unknown worker error";
      return { type: "error", message };
    }
    case "native": {
      if (typeof raw.framework !== "string") {
        throw new Error("native event missing string `framework`");
      }
      if (raw.event === undefined) {
        throw new Error("native event missing `event`");
      }
      return { type: "native", framework: raw.framework, event: raw.event };
    }
    case "hello": {
      if (typeof raw.framework !== "string") {
        throw new Error("hello event missing string `framework`");
      }
      const sdkName = typeof raw.sdkName === "string" ? raw.sdkName : null;
      const sdkVersion = typeof raw.sdkVersion === "string" ? raw.sdkVersion : null;
      return { type: "hello", framework: raw.framework, sdkName, sdkVersion };
    }
    default:
      throw new Error(`unknown event type: ${String(raw.type)}`);
  }
}
