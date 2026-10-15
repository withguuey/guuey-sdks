/**
 * FROZEN test fixture: `parseEvent` exactly as it stood before a worker's
 * `done` could carry `endThread`. It stands in for an older Router reading a
 * newer worker's event stream (the N−1 direction), so do not edit it to follow
 * `../parse.ts`; a later protocol change gets a new frozen copy beside this
 * one. Only the imports are adjusted to this directory, and the helper it
 * needs is kept with it.
 */
import type { JsonValue, StopReason, WorkerEvent } from "../protocol.js";

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Router-side typed interpreter: validate one NDJSON event line (Worker→Router,
 * fd 3) into a typed {@link WorkerEvent}. Mirror of `parseControl`; a
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
      // Additive-optional: kept only as a list of strings; any other shape reads as none.
      const caps = raw.capabilities;
      const capabilities =
        Array.isArray(caps) && caps.every((c): c is string => typeof c === "string") ? caps : undefined;
      return {
        type: "hello",
        framework: raw.framework,
        sdkName,
        sdkVersion,
        ...(capabilities !== undefined && capabilities.length > 0 ? { capabilities } : {}),
      };
    }
    case "suspend": {
      if (typeof raw.envelope !== "string") {
        throw new Error("suspend event missing string `envelope`");
      }
      const ids = raw.askIds;
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) {
        throw new Error("suspend event `askIds` must be a list of strings");
      }
      return { type: "suspend", envelope: raw.envelope, askIds: ids };
    }
    default:
      throw new Error(`unknown event type: ${String(raw.type)}`);
  }
}
