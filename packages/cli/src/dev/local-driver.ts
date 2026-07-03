/**
 * `guuey dev` local worker driver — the CLI-side mirror of the pod's
 * `worker-driver.ts` (`createWorkerDriver`), bare-spawn only (no bwrap/sandbox/
 * layers — the pod's hosted branches). Spawns the framework worker as a plain
 * child process, writes one v1 `invoke` to its stdin, and yields the worker's
 * fd-3 NDJSON events (Worker Protocol v1) as typed {@link WorkerEvent}s —
 * verbatim, no bridge. Used by `guuey dev --serve` (Task 11) to run a builder's
 * worker locally against the same wire contract as production.
 *
 * Transcribed from `backend/services/nocode-runtime/src/worker-driver.ts:236-347`
 * (`createWorkerDriver`'s `run` closure) MINUS the sandbox/bwrap/layers branches
 * and the §1.4 `priorMemory`/`priorState` push (no thread-memory fold in local
 * dev) — see the task report's transcription-fidelity section for the itemized
 * diff.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { isDone, isError, type WorkerEvent } from "@guuey/worker";
import { readNdjson } from "./ndjson.js";

/**
 * Grace window (ms) between the abort SIGTERM and the escalation SIGKILL.
 * Mirrors the pod's `DEFAULT_KILL_GRACE_MS` (F7) — local dev workers get the
 * same well-behaved-exit budget before a hard kill.
 */
const DEFAULT_KILL_GRACE_MS = 2000;

/** The local dev run-seam input — the CLI's minimal analogue of the pod's `RunInput`. */
export interface LocalRunInput {
  input: string;
  history: Array<{ role: "user" | "agent"; text: string }>;
  fs: { app: string; home: string; session: string };
  /**
   * REPLACES the child's environment wholesale (pod parity — the spawn's
   * explicit `env` option, never an implicit inherit of the CLI process env).
   */
  env: NodeJS.ProcessEnv;
  abortSignal: AbortSignal;
}

/**
 * Resolve with the child's exit code (or -1 when killed/failed without a code).
 * Never rejects: a spawn failure fires `'error'` (captured by the spawn-time
 * listener into `spawnError`) and never a `'close'`, so we resolve `-1` here and
 * let the caller prefer the real `spawnError` message for the terminal throw.
 */
function waitExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

/**
 * Build the Router-shaped `run` callback for local dev. Each call to the
 * returned function spawns one worker subprocess for the turn, writes the v1
 * invoke to its stdin, and yields the worker's fd-3 NDJSON events (Worker
 * Protocol v1) as typed {@link WorkerEvent}s — verbatim, no bridge.
 */
export function createLocalDriver(opts: {
  command: string;
  args: string[];
  killGraceMs?: number;
}): (input: LocalRunInput) => AsyncIterable<WorkerEvent> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return async function* run(input: LocalRunInput): AsyncIterable<WorkerEvent> {
    // Bare spawn only — no bwrap/sandbox wrap (pod's `buildWorkerArgv` w/
    // `sandbox: true` branch). `env` is passed explicitly so the child sees
    // ONLY the caller-provided env, matching the pod's non-sandbox contract.
    const child = spawn(opts.command, opts.args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: input.env,
    });
    const fd3 = child.stdio[3];
    if (!(fd3 instanceof Readable)) {
      // fd 3 must be the event pipe.
      throw new Error("worker fd 3 (event channel) unavailable");
    }

    // F7 abort escalation. SIGTERM first (lets a well-behaved worker flush +
    // exit); if the child has not closed within the grace window, SIGKILL it.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    child.on("close", () => {
      closed = true;
    });
    const terminate = (): void => {
      if (closed || child.killed) {
        // Already gone (or a SIGTERM is in flight from a prior terminate()); if a
        // prior call armed the escalation timer, leave it running.
        if (!child.killed) return;
      }
      child.kill("SIGTERM");
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, killGraceMs);
        // Don't keep the event loop alive solely for the escalation timer.
        if (typeof killTimer.unref === "function") killTimer.unref();
      }
    };
    const onAbort = (): void => terminate();
    input.abortSignal.addEventListener("abort", onAbort);

    // A spawn failure (ENOENT bad command, EACCES) fires `'error'` on the child
    // once, with no `'close'` code. Register the listener AT spawn time so the
    // real OS error is captured even if it fires before the NDJSON loop starts —
    // the terminal throw below surfaces it instead of "exited -1 without done".
    let spawnError: Error | undefined;
    child.on("error", (e) => {
      spawnError = e instanceof Error ? e : new Error(String(e));
    });

    // The worker's stdout (1) + stderr (2) are ITS logs now — log, don't parse.
    // Plain console.error (dev-tool logging, not the pod's structured logger).
    child.stdout.on("data", (d) => console.error(`[worker stdout] ${String(d).trimEnd()}`));
    child.stderr.on("data", (d) => console.error(`[worker stderr] ${String(d).trimEnd()}`));
    // A worker that crashes before reading stdin makes our write hit EPIPE. An
    // unhandled `'error'` on a Node stream is THROWN — swallow-to-log keeps the
    // CLI process alive; the terminal throw below still reports the failure.
    child.stdin.on("error", (e) =>
      console.error(`[worker stdin] ${e instanceof Error ? e.message : String(e)}`),
    );

    const invoke = {
      type: "invoke" as const,
      input: input.input,
      identity: { userId: "dev-user", authMode: "anonymous" as const },
      fs: input.fs,
      history: input.history,
    };
    child.stdin.write(JSON.stringify(invoke) + "\n");
    child.stdin.end();

    try {
      let sawDone = false;
      for await (const ev of readNdjson(fd3)) {
        if (isError(ev)) {
          // Surface the worker's terminal failure as a thrown turn error.
          throw new Error(`worker error: ${ev.message}`);
        }
        if (isDone(ev)) sawDone = true;
        // EVERY event — text / native / done — is yielded verbatim.
        yield ev;
      }
      const code = await waitExit(child);
      // An abort (Ctrl-C / ceiling) is an EXPECTED termination — the child was
      // killed on purpose, so a non-zero/killed exit is not a turn failure.
      if (input.abortSignal.aborted) return;
      // A spawn failure (captured at spawn time) takes precedence over a
      // synthetic exit code, so the thrown turn error carries the REAL OS
      // message (ENOENT/EACCES) instead of "exited -1 without a done event".
      if (spawnError) {
        throw new Error(`worker failed to start: ${spawnError.message}`);
      }
      // A clean done OR a 0-exit is a successful turn (a worker may close fd-3
      // without an explicit `done`; the downstream assembler tolerates that).
      if (!sawDone && code !== 0) {
        throw new Error(`worker exited ${code} without a done event`);
      }
    } finally {
      input.abortSignal.removeEventListener("abort", onAbort);
      // Ensure the child is gone (and escalation armed) even on a normal return /
      // a thrown error — never leak a worker subprocess.
      if (!closed && !child.killed) terminate();
      if (killTimer !== undefined) {
        // If the child already closed, cancel the pending hard-kill.
        if (closed) clearTimeout(killTimer);
      }
    }
  };
}
