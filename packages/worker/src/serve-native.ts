/**
 * Native-streaming serve loop: mirrors `serve.ts`'s line-reading, idle-timeout,
 * and shutdown handling exactly, but the per-invoke body emits opaque
 * framework-native events (`emit.native`) alongside text, instead of driving a
 * `Turn`. Lets a template worker emit `hello` → `native`* → `done` per invoke,
 * like `@guuey/host` does.
 */
import { createWriteStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
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
  /** Installed SDK version for the hello handshake. When OMITTED (the
   *  template default), it is resolved at runtime from `sdkName`'s installed
   *  package.json — works for unbundled workers with a real node_modules;
   *  degrades to null inside a self-contained bundle (nothing to resolve). */
  sdkVersion?: string | null;
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

    emitter.hello(
      info.framework,
      info.sdkName ?? null,
      info.sdkVersion !== undefined
        ? info.sdkVersion
        : info.sdkName
          ? resolveInstalledVersion(info.sdkName)
          : null,
    );
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
