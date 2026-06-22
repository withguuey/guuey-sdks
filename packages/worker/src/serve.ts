/**
 * Tier-2 managed loop. Reads the NDJSON control stream (fd 0), drives the handler
 * per `invoke`, emits events on fd 3, and handles `shutdown`/EOF and an idle
 * timeout. `serveOn` is the injectable, unit-testable core; `serve` defaults the
 * streams to `process.stdin` + an fd-3 Writable.
 *
 * Turns are inherently sequential — the handler for an `invoke` is `await`ed
 * inline before the reader advances to the next control line — so no chaining or
 * concurrent reader is needed.
 */
import { createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { createEmitter } from "./emit.js";
import { isInvoke, isShutdown, parseControl } from "./parse.js";
import { Turn, type WorkerHandler } from "./turn.js";

export interface ServeOptions {
  input: Readable;
  output: Writable;
  /** Stop the loop after this many ms with no control input (default 5 min). */
  idleMs?: number;
}

/** Async-iterate NDJSON lines off a Readable. */
async function* lines(input: Readable): AsyncIterable<string> {
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

export async function serveOn(handler: WorkerHandler, opts: ServeOptions): Promise<void> {
  const emit = createEmitter(opts.output);
  const idleMs = opts.idleMs ?? 5 * 60_000;

  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => opts.input.push(null), idleMs);
    if (idle.unref) idle.unref();
  };

  arm();
  for await (const line of lines(opts.input)) {
    arm();
    const msg = parseControl(line);
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;
    // Run the turn inline: turns are sequential, so the next control line is read
    // only after this handler settles.
    let acc = "";
    const turn = new Turn(msg.input, msg.identity, msg.fs, msg.history, emit, (chunk) => {
      acc += chunk;
    });
    try {
      const result = await handler(turn);
      emit.done(typeof result === "string" ? result : acc);
    } catch (err) {
      emit.error(err instanceof Error ? err.message : String(err));
    }
  }
  if (idle) clearTimeout(idle);
}

/** The public entry: wire stdin (fd 0) + an fd-3 Writable, then run the loop. */
export function serve(handler: WorkerHandler, opts?: { idleMs?: number }): Promise<void> {
  // fd 3 is the write end of the pipe the Router created at spawn.
  const output = createWriteStream("", { fd: 3 });
  return serveOn(handler, {
    input: process.stdin,
    output,
    ...(opts?.idleMs ? { idleMs: opts.idleMs } : {}),
  });
}
