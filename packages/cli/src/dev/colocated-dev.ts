/**
 * `guuey dev` local colocated-MCP auto-spawn (Task 7).
 *
 * Production runs `kind: 'colocated'` MCP servers as HTTP children INSIDE the
 * agent pod, supervised by the Router (`backend/services/nocode-runtime/src/
 * colocated-supervisor.ts`). Locally there is no pod and no supervisor —
 * `guuey dev` is the only process around, so it takes over the equivalent
 * job for the dev loop: for every colocated entry with a `devPort` (the same
 * `devPort` `lowerForDev` rewrites into a `http://localhost:<devPort>/mcp`
 * `external` entry), spawn the entry's own dev server as a plain child
 * process, bound to that port.
 *
 * Bare spawn only — no bwrap/sandbox (mirrors `local-driver.ts`'s documented
 * bare-spawn stance: the pod's sandbox branches don't apply outside a pod).
 * stdio is prefixed per-child and forwarded to this process's own
 * stdout/stderr, mirroring the scaffolded template's `scripts/dev.mjs`
 * `boot()` helper (same prefix-and-relay shape, same tool for the same job).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

/** One colocated MCP server to auto-spawn — the fields `lowerForDev` needs
 *  to have already accepted (name + source + a required `devPort`). */
export interface ColocatedDevEntry {
  name: string;
  /** Source directory, relative to `projectRoot` (same as `guuey.json#agent.mcpServers.<name>.source`). */
  source: string;
  devPort: number;
}

export interface ColocatedDevHandle {
  /** SIGTERM every spawned child's whole process group (see
   *  `terminateGroup`). Idempotent — safe to call more than once (e.g. once
   *  from `guuey dev`'s own shutdown handler and once from a test's
   *  cleanup). */
  stop(): void;
  /**
   * Resolves once EVERY spawned child has settled — `ready` (its `devPort`
   * accepts a TCP connection) or `degraded` (it exited first, or missed the
   * readiness deadline). Never rejects: a degraded child never blocks the
   * dev loop, same as the pod's supervisor. `guuey dev` awaits this BEFORE
   * binding its own server (guuey#770) — the order the hosted pod boots in
   * (`bootColocated` settles before `startSseServer` binds), so a `/readyz`
   * 200 means the colocated tools are dialable, not merely spawned.
   * Resolves immediately when nothing was spawned.
   */
  settled: Promise<void>;
  /**
   * Names of the children that are `degraded` — read LIVE, the same signal
   * the pod's `/readyz` reads from its supervisor (`colocatedDegraded`,
   * `sse-server.ts`). A child degrades by exiting (before OR after it became
   * ready — locally there is no restart budget: a crashed dev server is the
   * builder's to fix and re-run) or by missing the readiness deadline.
   * Children `stop()` tore down are never degraded — that is the state
   * stop() asked for.
   */
  degraded(): string[];
}

export interface ColocatedDevOptions {
  /**
   * Readiness deadline per child, ms from spawn; missed → `degraded`.
   * Default 30 000 — the pod supervisor's default
   * (`colocated-supervisor.ts` `readinessTimeoutMs`).
   */
  readinessTimeoutMs?: number;
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
/** Mirrors the pod supervisor's `READINESS_POLL_INTERVAL_MS`. */
const READINESS_POLL_INTERVAL_MS = 200;
/** Mirrors the pod supervisor's `TCP_PROBE_TIMEOUT_MS`. */
const TCP_PROBE_TIMEOUT_MS = 1000;

interface PackageJsonScripts {
  scripts?: Record<string, string>;
}

/**
 * One TCP connect attempt against `127.0.0.1:<port>` — the same probe the
 * pod supervisor readies a colocated child on (`colocated-supervisor.ts`
 * `tcpProbe`): "accepts a connection" is the honest, protocol-blind signal
 * that a dev server is listening (its `/mcp` answers non-200 to a bare GET,
 * so an HTTP probe would have to special-case every server's wire).
 */
function tcpProbe(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

type ChildStatus = "starting" | "ready" | "degraded";

interface ChildRecord {
  name: string;
  devPort: number;
  child: ChildProcess;
  status: ChildStatus;
  /** Resolves the first time the child leaves `starting` (unblocks `settled`). */
  settle: () => void;
  pollTimer: NodeJS.Timeout | undefined;
}

/**
 * SIGTERM a spawned child's whole process group.
 *
 * `pnpm run <script>` is not one process. The `pnpm` on PATH re-execs the
 * version-managed pnpm, which then runs the script's command as a child of
 * its own (through a shell, depending on the script) — so the dev server we
 * actually want to stop is a grand- or great-grandchild. `child.kill()`
 * signals only the direct child, which pnpm does NOT forward: the dev
 * server survives `guuey dev`, keeps `devPort` bound, and the next
 * `guuey dev` dies with EADDRINUSE.
 *
 * So children are spawned `detached` — POSIX `setsid()`, which makes the
 * child its own process-group leader with `pgid === child.pid` — and torn
 * down by signalling the negative pid, which the kernel delivers to every
 * process in that group. Same idiom, same reason as `create-agentic-app`'s
 * `scripts/verdaccio-smoke.mjs#killGroup`.
 *
 * POSIX-only, like the bare-spawn stance above (`process.kill(-pid)` has no
 * Windows equivalent, and `spawn('pnpm', …)` without a shell doesn't resolve
 * `pnpm.cmd` there either).
 */
function terminateGroup(child: ChildProcess): void {
  const pid = child.pid;
  // No pid at all = the spawn itself failed; a settled exitCode/signalCode =
  // the group is already gone. Either way there is nothing to signal, and
  // `process.kill(-undefined)` / a recycled pid must never be attempted.
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    // ESRCH: the group exited between the liveness check above and the
    // signal. That IS the state stop() asked for, not a failure. Anything
    // else (EPERM, …) is a real fault and must surface.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH") return;
    throw err;
  }
}

/**
 * pnpm ≥11 makes the ignored-build-scripts gate FATAL on fresh installs: a
 * colocated server whose deps carry postinstall scripts (the classic: tsx →
 * esbuild's platform-binary fetch) dies with `ERR_PNPM_IGNORED_BUILDS`, the
 * server never binds its devPort, and the raw pnpm stack scrolling past a
 * child prefix names no fix (guuey#120). When the marker shows up in a
 * child's output, print ONE targeted hint naming the dir + the declarative
 * per-package approval. Deliberately NOT auto-passing an allow-builds flag —
 * that would defeat pnpm's supply-chain gate; trust stays a human decision.
 */
const IGNORED_BUILDS_MARKER = "ERR_PNPM_IGNORED_BUILDS";

function ignoredBuildsHint(name: string, source: string): string {
  return [
    `guuey dev: colocated MCP "${name}" (${source}) hit pnpm's ignored-build-scripts gate (${IGNORED_BUILDS_MARKER}).`,
    `  A dependency's build script needs approval before pnpm will run it (classic: tsx → esbuild's platform-binary fetch).`,
    `  Declare the trust where pnpm reads it — the workspace-root package.json (or ${source}/package.json for a standalone install):`,
    `    "pnpm": { "onlyBuiltDependencies": ["esbuild"] }`,
    `  then re-run pnpm install there. Approve the specific packages only — don't disable the build gate wholesale.`,
  ].join("\n");
}

/**
 * Watch a child's output for {@link IGNORED_BUILDS_MARKER} and fire `onHit`
 * once. The marker can straddle chunk boundaries, so a tail of the previous
 * chunk is kept and prepended before scanning.
 */
function makeIgnoredBuildsScanner(onHit: () => void): (chunk: string) => void {
  let tail = "";
  let hit = false;
  return (chunk: string): void => {
    if (hit) return;
    const hay = tail + chunk;
    if (hay.includes(IGNORED_BUILDS_MARKER)) {
      hit = true;
      onHit();
      return;
    }
    tail = hay.slice(-(IGNORED_BUILDS_MARKER.length - 1));
  };
}

/** `"dev"` if the entry's `package.json` declares one, else `"start"`, else
 *  `undefined` (neither present — nothing to spawn, caller warns + skips). */
function resolveScript(packageJsonPath: string): "dev" | "start" | undefined {
  if (!existsSync(packageJsonPath)) return undefined;
  let pkg: PackageJsonScripts;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonScripts;
  } catch {
    return undefined;
  }
  if (typeof pkg.scripts?.dev === "string") return "dev";
  if (typeof pkg.scripts?.start === "string") return "start";
  return undefined;
}

/**
 * Auto-spawn every colocated MCP server's local dev process. For each
 * entry: resolve `<projectRoot>/<source>/package.json`'s `dev` script (else
 * `start`; neither present → skip with a console warning naming the fix),
 * then `pnpm run <script>` with `cwd` set to the source directory and
 * `PORT=<devPort>` in its env — the same `PORT` contract the scaffolded
 * `mcp-base` template (and the pod) already read.
 *
 * Returns a handle whose `stop()` SIGTERMs every spawned child's whole
 * process group (`terminateGroup` — the dev server is pnpm's child, not
 * ours, so signalling the direct child alone would leak it), whose
 * `settled` resolves once every child is ready-or-degraded, and whose
 * `degraded()` names the dead ones live (see {@link ColocatedDevHandle}).
 * Never throws on a per-entry spawn/script-resolution problem — a broken
 * colocated MCP shouldn't take down the rest of `guuey dev`.
 */
export function spawnColocatedDev(
  entries: ColocatedDevEntry[],
  projectRoot: string,
  options: ColocatedDevOptions = {},
): ColocatedDevHandle {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const records: ChildRecord[] = [];
  const settles: Promise<void>[] = [];
  let stopped = false;

  function markReady(rec: ChildRecord): void {
    if (rec.status !== "starting") return;
    rec.status = "ready";
    rec.settle();
  }

  function markDegraded(rec: ChildRecord, why: string): void {
    if (rec.status === "degraded") return;
    const wasStarting = rec.status === "starting";
    rec.status = "degraded";
    if (rec.pollTimer !== undefined) {
      clearTimeout(rec.pollTimer);
      rec.pollTimer = undefined;
    }
    console.warn(
      `guuey dev: colocated MCP "${rec.name}" is DEGRADED (${why}) — /readyz answers 503 until it is fixed and guuey dev restarted`,
    );
    if (wasStarting) rec.settle();
  }

  /** Poll `tcpProbe` until the child listens, exits, or the deadline passes. */
  function startReadinessProbe(rec: ChildRecord): void {
    const deadline = Date.now() + readinessTimeoutMs;
    const attempt = (): void => {
      rec.pollTimer = undefined;
      if (stopped || rec.status !== "starting") return;
      if (Date.now() >= deadline) {
        markDegraded(rec, `not listening on :${rec.devPort} within ${readinessTimeoutMs}ms`);
        return;
      }
      void tcpProbe(rec.devPort).then((ok) => {
        if (stopped || rec.status !== "starting") return;
        if (ok) {
          markReady(rec);
          return;
        }
        rec.pollTimer = setTimeout(attempt, READINESS_POLL_INTERVAL_MS);
      });
    };
    attempt();
  }

  for (const entry of entries) {
    const cwd = join(projectRoot, entry.source);
    const script = resolveScript(join(cwd, "package.json"));
    if (script === undefined) {
      console.warn(
        `guuey dev: skipping colocated MCP "${entry.name}" (${entry.source}) — its package.json has neither a "dev" nor a "start" script`,
      );
      continue;
    }

    const child = spawn("pnpm", ["run", script], {
      cwd,
      env: { ...process.env, PORT: String(entry.devPort) },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so stop() can tear down the whole pnpm→dev-server
      // tree — see `terminateGroup`. NOT unref'd: this process still owns the
      // child's stdio relay and its shutdown.
      detached: true,
    });
    const prefix = `[${entry.name}]`.padEnd(9);
    // One scanner per entry, shared across both streams (pnpm's error can
    // land on either) — the hint fires at most once per colocated server.
    const scanForIgnoredBuilds = makeIgnoredBuildsScanner(() =>
      console.warn(ignoredBuildsHint(entry.name, entry.source)),
    );
    child.stdout?.on("data", (d: Buffer) => {
      const text = String(d);
      process.stdout.write(text.replace(/^/gm, prefix));
      scanForIgnoredBuilds(text);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = String(d);
      process.stderr.write(text.replace(/^/gm, prefix));
      scanForIgnoredBuilds(text);
    });

    let settle: () => void = () => undefined;
    settles.push(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const rec: ChildRecord = {
      name: entry.name,
      devPort: entry.devPort,
      child,
      status: "starting",
      settle,
      pollTimer: undefined,
    };
    // An exit while we are still running it is terminal (locally there is no
    // restart budget); an exit after stop() is the state stop() asked for.
    child.once("exit", (code, signal) => {
      if (stopped) return;
      markDegraded(rec, `exited (${signal ?? `code ${code}`})`);
    });
    child.once("error", (err) => {
      if (stopped) return;
      markDegraded(rec, `spawn failed: ${err.message}`);
    });
    records.push(rec);
    startReadinessProbe(rec);
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const rec of records) {
        if (rec.pollTimer !== undefined) {
          clearTimeout(rec.pollTimer);
          rec.pollTimer = undefined;
        }
        // A child still `starting` at stop() settles now, so a caller
        // awaiting `settled` is never left hanging on a torn-down child.
        if (rec.status === "starting") rec.settle();
        terminateGroup(rec.child);
      }
    },
    settled: Promise.all(settles).then(() => undefined),
    degraded(): string[] {
      return records.filter((rec) => rec.status === "degraded").map((rec) => rec.name);
    },
  };
}
