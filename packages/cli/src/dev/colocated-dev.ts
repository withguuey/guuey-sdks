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
}

interface PackageJsonScripts {
  scripts?: Record<string, string>;
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
 * ours, so signalling the direct child alone would leak it). Never
 * throws on a per-entry spawn/script-resolution problem — a broken
 * colocated MCP shouldn't take down the rest of `guuey dev`.
 */
export function spawnColocatedDev(
  entries: ColocatedDevEntry[],
  projectRoot: string,
): ColocatedDevHandle {
  const children: ChildProcess[] = [];

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
    child.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(String(d).replace(/^/gm, prefix)),
    );
    child.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(String(d).replace(/^/gm, prefix)),
    );
    children.push(child);
  }

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const child of children) terminateGroup(child);
    },
  };
}
