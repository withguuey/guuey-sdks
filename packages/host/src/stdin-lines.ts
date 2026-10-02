/**
 * The host's control-stream line reader (fd 0), kept out of `index.ts` (which
 * runs `main()` on import) so it can be tested.
 */
import { StringDecoder } from "node:string_decoder";

/**
 * Async-iterate NDJSON lines off stdin. Bytes are decoded as one UTF-8 stream,
 * so a character split across two chunks arrives whole (decoding each chunk
 * alone would turn its halves into U+FFFD).
 */
export async function* lines(input: NodeJS.ReadableStream): AsyncIterable<string> {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.end();
  const tail = buf.trim();
  if (tail.length > 0) yield tail;
}
