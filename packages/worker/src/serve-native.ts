/**
 * Native-streaming serve loop: mirrors `serve.ts`'s line-reading, idle-timeout,
 * and shutdown handling exactly, but the per-invoke body emits opaque
 * framework-native events (`emit.native`) alongside text, instead of driving a
 * `Turn`. Lets a template worker emit `hello` → `native`* → `done` per invoke,
 * like `@guuey/host` does.
 */
import { createWriteStream } from "node:fs";
import { createEmitter, type Emitter } from "./emit.js";
import { lines } from "./lines.js";
import { isInvoke, isShutdown, parseControl } from "./parse.js";
import type { Invoke, JsonValue } from "./protocol.js";
import type { ServeOptions } from "./serve.js";

export interface NativeEmit {
  native(event: JsonValue): void;
  text(chunk: string): void;
}
export type NativeHandler = (
  invoke: Invoke,
  emit: NativeEmit
) => Promise<string | void> | string | void;
export interface NativeServeInfo {
  framework: string;
  sdkName?: string | null;
  sdkVersion?: string | null;
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

    emitter.hello(info.framework, info.sdkName ?? null, info.sdkVersion ?? null);
    try {
      const scoped: NativeEmit = {
        native: (event) => emitter.native(info.framework, event),
        text: (chunk) => emitter.text(chunk),
      };
      const result = await handler(msg, scoped);
      emitter.done(typeof result === "string" ? result : "", "end_turn");
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
