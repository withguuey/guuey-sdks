import type { Readable } from "node:stream";

/**
 * Every byte a test's output stream holds, as UTF-8.
 *
 * Reads until the buffer is empty. A single `read()` no longer does that: on Node 26, after the stream ends,
 * `read()` with no size returns only the first buffered chunk (Node 24 returned the whole buffer), so a turn's
 * captured bytes stopped at its `hello` line.
 */
export function drained(stream: Readable): string {
  const chunks: Buffer[] = [];
  for (let chunk: Buffer | null = stream.read(); chunk !== null; chunk = stream.read()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
