/**
 * The Worker→Router event emitter (fd 3). Serializes each {@link WorkerEvent} as
 * one NDJSON line to an injected Writable. The default `serve()` (T4) passes the
 * fd-3 stream; tests pass an in-memory stream. Each event is written immediately
 * (one `write` per line) so streaming never stalls behind a buffer.
 */
import type { JsonValue, StopReason, WorkerEvent } from "./protocol.js";

/** Minimal write interface accepted by {@link createEmitter}. `NodeJS.WritableStream` satisfies this. */
export interface WriteSink {
  write(s: string): void;
}

export interface Emitter {
  text(text: string): void;
  done(result: string, stopReason?: StopReason): void;
  error(message: string): void;
  native(framework: string, event: JsonValue): void;
  /** The SDK-version handshake (additive-optional, §8 item B). Emit at most
   *  once, before any native/turn event. */
  hello(framework: string, sdkName: string | null, sdkVersion: string | null): void;
}

export function createEmitter(out: WriteSink): Emitter {
  const write = (ev: WorkerEvent): void => {
    out.write(JSON.stringify(ev) + "\n");
  };
  return {
    text: (text) => write({ type: "text", text }),
    done: (result, stopReason = "end_turn") => write({ type: "done", stopReason, result }),
    error: (message) => write({ type: "error", message }),
    native: (framework, event) => write({ type: "native", framework, event }),
    hello: (framework, sdkName, sdkVersion) => write({ type: "hello", framework, sdkName, sdkVersion }),
  };
}
