/**
 * Read an fd-3 event stream as NDJSON: buffer chunks, split on `\n`, and
 * validate each non-empty line via {@link parseEvent} (Worker Protocol v1). A
 * non-JSON / unknown-type line throws a clear error (no silent skip). The
 * trailing partial line (no final `\n`) is parsed on stream end.
 *
 * Transcribed from `backend/services/nocode-runtime/src/worker-driver.ts:114`
 * (the pod's `readNdjson`) — CLI-side mirror, except that this one decodes
 * UTF-8 across chunk boundaries.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { parseEvent, type WorkerEvent } from "@guuey/worker";

export async function* readNdjson(stream: Readable): AsyncIterable<WorkerEvent> {
  // One UTF-8 decoder for the whole stream: a character split across two
  // chunks arrives whole instead of as two U+FFFD.
  const decoder = new StringDecoder("utf8");
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield parseEvent(line);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.end();
  const tail = buf.trim();
  if (tail.length > 0) yield parseEvent(tail);
}
