/**
 * Read an fd-3 event stream as NDJSON: buffer chunks, split on `\n`, and
 * validate each non-empty line via {@link readEvent} (Worker Protocol v1). A
 * non-JSON or malformed line throws a clear error. A well-formed line of a type
 * this release does not know (a newer worker's, guuey#3434) is not yielded: it
 * is handed to `onUnknown` with its type string, and reading goes on. The
 * trailing partial line (no final `\n`) is parsed on stream end.
 *
 * Transcribed from `backend/services/nocode-runtime/src/worker-driver.ts:114`
 * (the pod's `readNdjson`) — CLI-side mirror, except that this one decodes
 * UTF-8 across chunk boundaries.
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { isUnknownEvent, readEvent, type WorkerEvent } from "@guuey/worker";

export async function* readNdjson(stream: Readable, onUnknown: (rawType: string) => void): AsyncIterable<WorkerEvent> {
  const known = (line: string): WorkerEvent | undefined => {
    const event = readEvent(line);
    if (!isUnknownEvent(event)) return event;
    onUnknown(event.rawType);
    return undefined;
  };
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
      const event = line.length > 0 ? known(line) : undefined;
      if (event !== undefined) yield event;
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.end();
  const tail = buf.trim();
  const last = tail.length > 0 ? known(tail) : undefined;
  if (last !== undefined) yield last;
}
