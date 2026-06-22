/**
 * Tier-2 managed loop. Reads the NDJSON control stream (fd 0), drives the handler
 * per `invoke`, emits events on fd 3, and handles `ask↔answer`, `shutdown`/EOF,
 * and an idle timeout. `serveOn` is the injectable, unit-testable core; `serve`
 * defaults the streams to `process.stdin` + an fd-3 Writable.
 *
 * The control reader and the in-flight handler run CONCURRENTLY: a handler that
 * blocks on `turn.ask()` must NOT block the reader, or the `answer` it's waiting
 * for could never be read (deadlock). Turns are chained so they still run
 * sequentially; v1 ⇒ at most one pending `ask` at a time, so one `pendingAnswer`
 * resolver suffices (no request-id correlation).
 */
import { createWriteStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { createEmitter } from "./emit.js";
import { isAnswer, isInvoke, isShutdown, parseControl } from "./parse.js";
import { Turn, type WorkerHandler } from "./turn.js";
import type { Invoke, JsonValue } from "./protocol.js";

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
  let pendingAnswer: ((value: JsonValue) => void) | undefined;
  let chain: Promise<void> = Promise.resolve();

  let idle: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => opts.input.destroy(), idleMs);
    if (idle.unref) idle.unref();
  };

  const runTurn = async (invoke: Invoke): Promise<void> => {
    let acc = "";
    const turn = new Turn(
      invoke.input,
      invoke.identity,
      invoke.fs,
      invoke.history,
      emit,
      (prompt, schema) =>
        new Promise<JsonValue>((resolve) => {
          pendingAnswer = resolve;
          emit.ask(prompt, schema);
        }),
      (chunk) => {
        acc += chunk;
      }
    );
    try {
      const result = await handler(turn);
      emit.done(typeof result === "string" ? result : acc);
    } catch (err) {
      emit.error(err instanceof Error ? err.message : String(err));
    } finally {
      pendingAnswer = undefined;
    }
  };

  arm();
  for await (const line of lines(opts.input)) {
    arm();
    const msg = parseControl(line);
    if (isAnswer(msg)) {
      // Resolve a blocked `ask`; an answer with no pending ask is ignored.
      const resolve = pendingAnswer;
      pendingAnswer = undefined;
      resolve?.(msg.value);
      continue;
    }
    if (isShutdown(msg)) break;
    if (!isInvoke(msg)) continue;
    const invoke = msg;
    // Chain (turns stay sequential) but do NOT await here — the reader must stay
    // free to deliver the `answer` a blocked `ask` is waiting for.
    chain = chain.then(() => runTurn(invoke));
  }
  // Shutdown/EOF while a turn is blocked on `ask`: unblock it (null answer) so it
  // can finish and `chain` can resolve — never hang the process.
  if (pendingAnswer) {
    const resolve = pendingAnswer;
    pendingAnswer = undefined;
    resolve(null);
  }
  await chain;
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
