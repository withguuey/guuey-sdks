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
  Shutdown,
  StopReason,
  TextEvent,
  WorkerEvent,
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
      return {
        type: "invoke",
        input: raw.input,
        identity: parseIdentity(raw.identity),
        fs: parseFs(raw.fs),
        history: parseHistory(raw.history),
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
    default:
      throw new Error(`unknown event type: ${String(raw.type)}`);
  }
}
