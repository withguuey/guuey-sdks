/**
 * The Worker→Router event emitter (fd 3). Serializes each {@link WorkerEvent} as
 * one NDJSON line to an injected Writable. The default `serve()` (T4) passes the
 * fd-3 stream; tests pass an in-memory stream. Each event is written immediately
 * (one `write` per line) so streaming never stalls behind a buffer.
 */
import type { StopReason, WorkerEvent } from "./protocol.js";

export interface Emitter {
  text(text: string): void;
  done(result: string, stopReason?: StopReason): void;
  error(message: string): void;
}

export function createEmitter(out: NodeJS.WritableStream): Emitter {
  const write = (ev: WorkerEvent): void => {
    out.write(JSON.stringify(ev) + "\n");
  };
  return {
    text: (text) => write({ type: "text", text }),
    done: (result, stopReason = "end_turn") => write({ type: "done", stopReason, result }),
    error: (message) => write({ type: "error", message }),
  };
}
