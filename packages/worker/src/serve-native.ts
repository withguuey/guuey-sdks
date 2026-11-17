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
import {
  CLI_SESSION_CAPABILITY,
  HOST_SUSPEND_CAPABILITY,
  type EndThread,
  type HelloCliSession,
  type Invoke,
  type JsonValue,
} from "./protocol.js";
import {
  applyClaudeSession,
  cliSessionNotAppliedMessage,
  workerClaudeSessionGate,
  type WorkerClaudeSession,
  type WorkerClaudeSessionTurn,
} from "./claude-session.js";
import { endThreadProblem } from "./end-thread.js";
import { invokeImagesCapabilities } from "./images.js";
import { storeTurnImages } from "./turn-images-store.js";
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
  /**
   * guuey#3550: apply the invoke's {@link Invoke.cliSession} to this Claude turn, for a worker served with
   * {@link NativeServeInfo.claudeSession}. Call it once, with exactly the values the turn passes `query()`, BEFORE
   * anything else is emitted: it sends the hello with the thread-resume block. Spread the answer's `options` into the
   * SDK's options and its `env` into the SDK's `env`, and pass the CLI's first message to `confirmFirst`; a string
   * back is the turn's error (throw it), and nothing of the turn may be emitted.
   *
   * On an invoke with no session, or a `start` this worker cannot apply, it answers `undefined`, applies nothing and
   * sends a plain hello; the turn runs as before, with its history (one line on stderr says why a `start` was not
   * applied). A `resume` carries NO history, because the session holds it, so a `resume` this worker cannot apply
   * THROWS (`cli_session_resume_failed: not applied (...)`) and the Router re-runs the turn as a start: the platform
   * did not set the CLI's config root and binary, the system prompt is not one string, or the hello has already gone.
   * It also throws on a refusal: a session id that is not a UUID, a stored session that does not match the
   * platform's record.
   *
   * Not a boundary: the platform isolates each thread's session itself. This keeps an honest worker's thread intact.
   *
   * Optional on the type so an emit built by hand (a test's stand-in) need not name it; serveNative always provides it.
   */
  claudeSession?(turn: WorkerClaudeSessionTurn): WorkerClaudeSession | undefined;
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
  /**
   * guuey#2549: what else this worker declares on its hello, beyond suspend: the
   * {@link inputKindCapability} names of the input kinds it handles. A worker
   * declares `input-kind:context-only` only when its current input AND its
   * history go through {@link modelInputOf} / {@link modelTextOf} (or
   * {@link MODEL_TEXT_INPUT_KIND_CAPABILITIES}, which names exactly that). The
   * Router sends an empty `input` with {@link Invoke.inputKind} only to a worker
   * whose hello declared that kind. {@link HOST_SUSPEND_CAPABILITY} is never
   * taken from here: it rides the hello only when {@link suspend} is set and the
   * invoke carried the offer, so a listed one is dropped.
   */
  capabilities?: readonly string[];
  /**
   * guuey#2293: this worker hands the invoke's images ({@link Invoke.attachments})
   * to its model, for example through {@link anthropicUserContent},
   * {@link openaiTurnInput} or {@link geminiUserParts}. On an invoke that carries
   * images, the hello then announces {@link INVOKE_IMAGES_CAPABILITY}, the word
   * the Router acknowledges the images to the person's client on. Without this
   * flag, or on an invoke with no images, the hello is exactly what it is
   * without the flag, and the Router refuses an image turn up front. With the
   * flag the turn's images are also stored in its session storage
   * ({@link storeTurnImages}) before the handler runs.
   */
  images?: true;
  /**
   * guuey#3550: this Claude worker resumes the CLI session the Router names ({@link NativeEmit.claudeSession}). The
   * invoke's hello is then held until the turn calls `claudeSession` or first writes anything (native, text, suspend,
   * done, error), so it can carry the thread-resume block. Without this flag the hello goes first, exactly as before.
   * Call `claudeSession` before any slow await: the hello is the turn's first event and nothing reaches the person
   * before it. No separate clock times the hello; the turn's own limits bound it.
   */
  claudeSession?: true;
}

/**
 * The hello's capability list for one invoke: the suspend capability exactly when
 * the writer exists, then the worker's declared ones in order, without repeats and
 * never a second (or ungated) suspend. Omitted when empty, as a hello without
 * capabilities was before.
 */
function helloCapabilities(suspendOffered: boolean, declared: readonly string[] | undefined): string[] | undefined {
  const out = suspendOffered ? [HOST_SUSPEND_CAPABILITY] : [];
  for (const name of declared ?? []) {
    if (name !== HOST_SUSPEND_CAPABILITY && !out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : undefined;
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
    const capabilities = helloCapabilities(suspendWriter !== undefined, [
      ...(info.capabilities ?? []),
      ...(info.images === true ? invokeImagesCapabilities(msg) : []),
    ]);
    // The invoke's ONE hello. Every write to fd 3 below passes through it first, so it is always the first event;
    // with `claudeSession` it waits for the turn's block (guuey#3550), otherwise it goes now.
    let helloSent = false;
    const hello = (block?: HelloCliSession): void => {
      if (helloSent) return;
      helloSent = true;
      emitter.hello(
        info.framework,
        info.sdkName ?? null,
        info.sdkVersion !== undefined
          ? info.sdkVersion
          : info.sdkName
            ? resolveInstalledVersion(info.sdkName)
            : null,
        block === undefined ? capabilities : [...(capabilities ?? []), CLI_SESSION_CAPABILITY],
        block,
      );
    };
    if (info.claudeSession !== true) hello();
    // guuey#2293: a worker that hands the turn's images to its model also stores
    // them in the turn's session storage before the turn runs; a refusal is the
    // person's face, and the turn does not run.
    if (info.images === true) {
      const face = storeTurnImages(msg);
      if (face !== undefined) {
        hello();
        emitter.error(face);
        continue;
      }
    }
    // This turn's request to end the conversation, held until its `done`.
    let endThread: EndThread | undefined;
    const closeOffered = msg.threadClose !== undefined;
    try {
      const scoped: NativeEmit = {
        native: (event) => {
          hello();
          emitter.native(info.framework, event);
        },
        text: (chunk) => {
          hello();
          emitter.text(chunk);
        },
        suspend: (envelope, askIds) => {
          if (suspendWriter === undefined) return "not_offered";
          hello();
          return suspendWriter.suspend(envelope, askIds);
        },
        endThread: (request) => {
          const problem = endThreadProblem(request);
          if (problem !== undefined) throw new TypeError(`endThread: ${problem}`);
          if (!closeOffered) return "not_offered";
          endThread = { code: request.code, message: request.message };
          return "ok";
        },
        claudeSession: (turn) => claudeSessionFor(msg, turn, () => helloSent, hello),
      };
      const result = await handler(msg, scoped);
      hello();
      emitter.done(typeof result === "string" ? result : "", "end_turn", endThread);
    } catch (e) {
      hello();
      emitter.error(e instanceof Error ? e.message : String(e));
    }
  }
  if (idle) clearTimeout(idle);
}

/**
 * {@link NativeEmit.claudeSession} for one invoke: the platform's gate, then `@guuey/worker`'s one sequence. The id and
 * environment checks read no file; only {@link applyClaudeSession}'s block, after them, reads the stored session.
 */
function claudeSessionFor(
  invoke: Invoke,
  turn: WorkerClaudeSessionTurn,
  isHelloSent: () => boolean,
  hello: (block?: HelloCliSession) => void,
): WorkerClaudeSession | undefined {
  const session = invoke.cliSession;
  // Not applied. A start runs as before, with its history; a resume has none to run with, so it refuses. The rule that
  // holds is the Router's: a resume whose first hello lacks cli-session.v1 resets at that hello and re-runs as a start
  // (threads-ddb decideHello, `no-capability`). This throw only names the reason in the builder's own log.
  const none = (why: string | undefined): undefined => {
    hello();
    if (why === undefined) return undefined;
    if (session?.mode === "resume") throw new Error(cliSessionNotAppliedMessage(why));
    process.stderr.write(`[guuey] no CLI session applied: ${why}\n`);
    return undefined;
  };
  if (isHelloSent()) return none(session === undefined ? undefined : "the hello was already sent");
  if (session === undefined) return none(undefined);
  const gate = workerClaudeSessionGate(process.env);
  if (!gate.ok) return none(gate.why);
  if (typeof turn.systemPrompt !== "string") return none("the system prompt is not one string");
  const applied = applyClaudeSession({
    session,
    systemPrompt: turn.systemPrompt,
    header: turn.header,
    servers: turn.servers,
    content: turn.content,
    configDir: gate.configDir,
    cwd: turn.cwd ?? process.cwd(),
    hello,
  });
  return {
    options: { ...applied.options, persistSession: true, pathToClaudeCodeExecutable: gate.executable },
    env: { CLAUDE_CONFIG_DIR: gate.configDir },
    block: applied.block,
    confirmFirst: applied.confirmFirst,
  };
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
