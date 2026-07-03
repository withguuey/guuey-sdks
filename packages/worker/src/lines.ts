/**
 * Shared NDJSON line-reader for the control stream (fd 0). Used by both the
 * tier-2 managed loop (`serve.ts`) and the native-streaming loop
 * (`serve-native.ts`) so the two serve tiers read lines identically.
 */
import type { Readable } from "node:stream";

/** Async-iterate NDJSON lines off a Readable. */
export async function* lines(input: Readable): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) yield tail;
}
