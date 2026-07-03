/**
 * Read an fd-3 event stream as NDJSON: buffer chunks, split on `\n`, and
 * validate each non-empty line via {@link parseEvent} (Worker Protocol v1). A
 * non-JSON / unknown-type line throws a clear error (no silent skip). The
 * trailing partial line (no final `\n`) is parsed on stream end.
 *
 * Transcribed from `backend/services/nocode-runtime/src/worker-driver.ts:114`
 * (the pod's `readNdjson`) — CLI-side mirror, no behavior changes.
 */
import type { Readable } from "node:stream";
import { parseEvent, type WorkerEvent } from "@guuey/worker";

export async function* readNdjson(stream: Readable): AsyncIterable<WorkerEvent> {
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield parseEvent(line);
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) yield parseEvent(tail);
}
