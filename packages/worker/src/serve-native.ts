/**
 * Native-streaming serve loop: mirrors `serve.ts`'s line-reading, idle-timeout,
 * and shutdown handling exactly, but the per-invoke body emits opaque
 * framework-native events (`emit.native`) alongside text, instead of driving a
 * `Turn`. Lets a template worker emit `hello` → `native`* → `done` per invoke,
 * like `@guuey/host` does (and, when it pauses, `suspend` before `done`).
 */
import { createWriteStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
import { createEmitter, type Emitter } from "./emit.js";
import { lines } from "./lines.js";
import { isInvoke, isShutdown, parseControl } from "./parse.js";
import { HOST_SUSPEND_CAPABILITY, type EndThread, type Invoke, type JsonValue } from "./protocol.js";
import { endThreadProblem } from "./end-thread.js";
import type { ServeOptions } from "./serve.js";
import { createSuspendWriter, type SuspendWriteResult } from "./suspend-writer.js";

export interface NativeEmit {
  native(event: JsonValue): void;
  text(chunk: string): void;
  /**
   * Pause the run: send its serialized state and the ids of the asks it waits
   * on, after the natives and before returning. `not_offered` when this
   * invoke cannot pause (the host did not opt in with
   * {@link NativeServeInfo.suspend}, or the Router made no offer): nothing was
   * written, and the turn should end as it does today. `over_cap`: the
   * envelope is larger than the offer allows, and nothing was written.
   */
  suspend(envelope: string, askIds: readonly string[]): SuspendWriteResult | "not_offered";
  /**
   * Ask the Router to end this conversation when the turn finishes: the
   * person reads `message` verbatim, and the client receives `code` (as
   * `app:<code>`) so it can show its own state, e.g. "this chat is full". Any
   * later message from the person starts a new conversation.
   *
   * `code` must match `^[A-Z][A-Z0-9_]{0,39}$`; `message` must be 1–500
   * characters with no control characters other than `\n`. Anything else
   * throws a `TypeError`. Answers `ok` when the request will ride this turn's
   * `done` (the last call of a turn wins), or `not_offered` when this invoke
   * cannot end its conversation (it carried no {@link Invoke.threadClose}, e.g.
   * a turn with no stored conversation, or an older Router): nothing is sent,
   * and the turn should say what it needs to in its own text. A handler that
   * throws afterwards ends the turn in error, and nothing is closed.
   */
  endThread(request: EndThread): "ok" | "not_offered";
}
export type NativeHandler = (
  invoke: Invoke,
  emit: NativeEmit
) => Promise<string | void> | string | void;
export interface NativeServeInfo {
  framework: string;
  sdkName?: string | null;
  /** Installed SDK version for the hello handshake. When OMITTED (the
   *  template default), it is resolved at runtime from `sdkName`'s installed
   *  package.json — works for unbundled workers with a real node_modules;
   *  degrades to null inside a self-contained bundle (nothing to resolve). */
  sdkVersion?: string | null;
  /**
   * This worker can pause and resume a run ({@link Invoke.suspend} /
   * {@link Invoke.resume}). On an invoke that carries the Router's offer, the
   * hello then announces {@link HOST_SUSPEND_CAPABILITY} and
   * {@link NativeEmit.suspend} writes. Without this flag, or on an invoke with
   * no offer, the fd-3 stream is exactly what it is without the flag.
   */
  suspend?: true;
}

/**
 * Resolve `pkgName`'s installed version by walking up from its resolved main
 * entry (a `require.resolve(pkg + "/package.json")` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED for SDKs whose exports map omits the
 * subpath — the claude/openai SDKs both do). Never throws: null when the
 * package can't be resolved (bundled worker, absent dep).
 */
export function resolveInstalledVersion(pkgName: string): string | null {
  try {
    const entry = require.resolve(pkgName);
    let dir = dirname(entry);
    for (let depth = 0; depth < 6; depth++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === pkgName) return pkg.version ?? null;
      } catch {
        // not at this level — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

export async function serveNativeOn(
  handler: NativeHandler,
  info: NativeServeInfo,
  opts: ServeOptions
): Promise<void> {
  const emitter: Emitter = createEmitter(opts.output);
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

    // The writer exists only when the host opted in AND the invoke carried the
    // offer (createSuspendWriter's own gate); the capability rides the hello
    // exactly when it does.
    const suspendWriter = info.suspend === true ? createSuspendWriter(opts.output, msg) : undefined;
    emitter.hello(
      info.framework,
      info.sdkName ?? null,
      info.sdkVersion !== undefined
        ? info.sdkVersion
        : info.sdkName
          ? resolveInstalledVersion(info.sdkName)
          : null,
      suspendWriter !== undefined ? [HOST_SUSPEND_CAPABILITY] : undefined,
    );
    // This turn's request to end the conversation, held until its `done`.
    let endThread: EndThread | undefined;
    const closeOffered = msg.threadClose !== undefined;
    try {
      const scoped: NativeEmit = {
        native: (event) => emitter.native(info.framework, event),
        text: (chunk) => emitter.text(chunk),
        suspend: (envelope, askIds) =>
          suspendWriter !== undefined ? suspendWriter.suspend(envelope, askIds) : "not_offered",
        endThread: (request) => {
          const problem = endThreadProblem(request);
          if (problem !== undefined) throw new TypeError(`endThread: ${problem}`);
          if (!closeOffered) return "not_offered";
          endThread = { code: request.code, message: request.message };
          return "ok";
        },
      };
      const result = await handler(msg, scoped);
      emitter.done(typeof result === "string" ? result : "", "end_turn", endThread);
    } catch (e) {
      emitter.error(e instanceof Error ? e.message : String(e));
    }
  }
  if (idle) clearTimeout(idle);
}

/** The public entry: wire stdin (fd 0) + an fd-3 Writable, then run the loop. */
export function serveNative(
  handler: NativeHandler,
  info: NativeServeInfo,
  opts?: { idleMs?: number }
): Promise<void> {
  // fd 3 is the write end of the pipe the Router created at spawn.
  const output = createWriteStream("", { fd: 3 });
  return serveNativeOn(handler, info, {
    input: process.stdin,
    output,
    ...(opts?.idleMs ? { idleMs: opts.idleMs } : {}),
  });
}
