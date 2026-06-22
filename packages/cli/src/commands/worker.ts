/**
 * `guuey worker verify [<entry>]` — a local Guuey Worker Protocol v1 conformance
 * harness. Spawns a candidate worker, sends a v1 invoke on fd 0, reads events on
 * fd 3, answers any `ask`, shuts down after `done`, and asserts conformance. This
 * is how a worker in any language proves v1-compliance (spec §1.8).
 */
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseEvent, isAsk, isDone, type WorkerEvent } from "@guuey/worker";
import * as out from "../output";

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface VerifyResult {
  pass: boolean;
  checks: VerifyCheck[];
  events: WorkerEvent[];
  exitCode: number | null;
}

/** The frozen v1 probe invoke (non-null `fs`, per the contract). */
const PROBE_INVOKE = {
  type: "invoke" as const,
  input: "guuey worker verify probe",
  identity: { userId: "verify", authMode: "anonymous" as const },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [] as { role: "user" | "agent"; text: string }[],
};

export async function verifyWorker(opts: {
  entry: string;
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const child = spawn("node", [opts.entry], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const fd3 = child.stdio[3];
  if (!(fd3 instanceof Readable)) {
    return {
      pass: false,
      checks: [
        { name: "fd-3 event channel available", ok: false, detail: "fd 3 not a readable pipe" },
      ],
      events: [],
      exitCode: null,
    };
  }
  child.stdout.on("data", () => {}); // the worker's logs — ignored by verify
  child.stderr.on("data", () => {});

  const events: WorkerEvent[] = [];
  let parseError: string | undefined;
  let sawDone = false;
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  if (timer.unref) timer.unref();

  child.stdin.on("error", () => {}); // a worker that dies before reading stdin → EPIPE; not our crash
  child.stdin.write(JSON.stringify(PROBE_INVOKE) + "\n");

  try {
    let buf = "";
    for await (const chunk of fd3) {
      buf += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.length === 0) continue;
        let ev: WorkerEvent;
        try {
          ev = parseEvent(line);
        } catch (e) {
          parseError = e instanceof Error ? e.message : String(e);
          continue;
        }
        events.push(ev);
        if (isAsk(ev)) {
          child.stdin.write(JSON.stringify({ type: "answer", value: "verify-answer" }) + "\n");
        } else if (isDone(ev)) {
          sawDone = true;
          child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
          child.stdin.end();
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const exitCode =
    child.exitCode ?? (await new Promise<number | null>((r) => child.on("close", (c) => r(c))));
  if (!child.killed) child.kill("SIGTERM");

  const checks: VerifyCheck[] = [
    { name: "emits valid v1 events on fd-3", ok: parseError === undefined, detail: parseError },
    { name: "reaches a terminal `done`", ok: sawDone },
    {
      name: "exits cleanly",
      ok: exitCode === 0,
      detail:
        exitCode === null
          ? "killed (timeout — never terminated?)"
          : exitCode === 0
            ? undefined
            : `exit ${exitCode}`,
    },
  ];
  return { pass: checks.every((c) => c.ok), checks, events, exitCode };
}

/** Resolve the worker entry: positional arg, else ./guuey.worker.js in cwd. */
function resolveEntry(entry: string | undefined): string | undefined {
  if (entry) {
    const abs = resolve(process.cwd(), entry);
    return existsSync(abs) ? abs : undefined;
  }
  const fallback = resolve(process.cwd(), "guuey.worker.js");
  return existsSync(fallback) ? fallback : undefined;
}

/** `guuey worker verify [<entry>]` handler. */
export async function workerVerify(
  entry: string | undefined,
  _flags: Record<string, string | true>
): Promise<void> {
  const resolved = resolveEntry(entry);
  if (!resolved) {
    out.error(
      entry
        ? `Worker entry not found: ${entry}`
        : "No worker entry. Pass a path: `guuey worker verify <entry.js>` (or add ./guuey.worker.js)."
    );
    process.exit(1);
  }
  console.log(`Verifying worker: ${resolved}`);
  const result = await verifyWorker({ entry: resolved });
  for (const c of result.checks) {
    if (c.ok) out.success(c.name);
    else out.error(`${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (result.pass) {
    out.success("Worker is Guuey Worker Protocol v1 conformant.");
    process.exit(0);
  }
  out.error("Worker is NOT v1 conformant (see failures above).");
  process.exit(1);
}
