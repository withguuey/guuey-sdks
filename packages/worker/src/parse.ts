/**
 * Tier-1 typed interpreter: validate one NDJSON control line (Router→Worker, fd
 * 0) into a typed {@link ControlMessage}. Hand-rolled guards keep the package
 * dependency-free. A malformed line throws a clear error (never a silent skip).
 */
import type {
  Answer,
  AuthMode,
  ControlMessage,
  Fs,
  HistoryMessage,
  Identity,
  Invoke,
  JsonValue,
  Shutdown,
} from "./protocol.js";

export function isInvoke(m: ControlMessage): m is Invoke {
  return m.type === "invoke";
}
export function isAnswer(m: ControlMessage): m is Answer {
  return m.type === "answer";
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
    case "answer":
      return { type: "answer", value: raw.value ?? null };
    case "shutdown":
      return { type: "shutdown" };
    default:
      throw new Error(`unknown control message type: ${String(raw.type)}`);
  }
}
