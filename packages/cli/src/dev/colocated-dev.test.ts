import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnColocatedDev, type ColocatedDevHandle } from "./colocated-dev.js";

const projectRoot = __dirname;

let handle: ColocatedDevHandle | undefined;
let markerDir: string | undefined;

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Wait for the fixture child's `<dir>/stopped` marker to appear.
 *
 * `spawnColocatedDev`'s `stop()` is deliberately fire-and-forget SIGTERM
 * (product semantics — unchanged here): it signals the child and returns
 * immediately, without waiting for the child to actually exit. The fixture
 * (`fixtures/colocated-child/index.mjs`) writes a `stopped` marker file
 * asynchronously, right before it calls `process.exit(0)`.
 *
 * Not every test in this file awaited that marker itself before finishing
 * (e.g. the idempotent-stop() test asserted synchronously), so `afterEach`'s
 * `rmSync(markerDir)` could race the child's still-in-flight write — the
 * child creating `stopped` AFTER `rmSync`'s recursive directory listing but
 * BEFORE its final `rmdir` produced an intermittent `ENOTEMPTY`. Waiting
 * here, once, in `afterEach`, closes that race for every test without
 * touching `stop()`'s real fire-and-forget contract. A genuine timeout (the
 * child never wrote its marker) is a real problem, not something to hide —
 * it propagates and fails the test, same as every other `waitFor` call in
 * this file.
 */
function waitForStoppedMarker(dir: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => existsSync(join(dir, "stopped")), timeoutMs);
}

afterEach(async () => {
  handle?.stop();
  try {
    if (markerDir) {
      await waitForStoppedMarker(markerDir);
    }
  } finally {
    // Reset even when the wait above throws — otherwise one test's missing
    // marker leaks its `markerDir` into every later hook and a single
    // failure cascades through the rest of the file.
    handle = undefined;
    if (markerDir) {
      delete process.env.FIXTURE_MARKER_DIR;
      rmSync(markerDir, { recursive: true, force: true });
      markerDir = undefined;
    }
  }
});

describe("spawnColocatedDev", () => {
  // The `stopped` half of this test is the regression pin for
  // `terminateGroup`: the fixture that writes the marker is NOT the process
  // `spawnColocatedDev` spawned — `pnpm` sits between them (and re-execs
  // itself), so the marker only ever appears if stop() signalled the child's
  // whole process group rather than just the direct child. Keep the fixture
  // behind `pnpm run` for that reason; spawning it directly would still pass
  // while leaking every real dev server.
  it("spawns the entry's dev script with PORT set in its env, settles READY once it listens on devPort, and stop() SIGTERMs it", async () => {
    markerDir = mkdtempSync(join(tmpdir(), "guuey-colocated-dev-"));
    process.env.FIXTURE_MARKER_DIR = markerDir;

    handle = spawnColocatedDev(
      [{ name: "notes", source: "fixtures/colocated-child", devPort: 34567 }],
      projectRoot,
    );

    await waitFor(() => existsSync(join(markerDir!, "started")));
    expect(readFileSync(join(markerDir!, "started"), "utf8")).toBe("PORT=34567");

    // guuey#770: `settled` resolves on the TCP door, the pod supervisor's
    // readiness signal — and a listening child is not degraded.
    await handle.settled;
    expect(handle.degraded()).toEqual([]);

    handle.stop();
    await waitFor(() => existsSync(join(markerDir!, "stopped")));
    // A child stop() tore down is the state stop() asked for — never degraded.
    expect(handle.degraded()).toEqual([]);
  });

  // guuey#770: the local analogues of the pod supervisor's `degraded` arms —
  // exit before ready, readiness deadline missed, exit after ready (no local
  // restart budget) — all surface through `degraded()`, the hook `guuey dev`
  // feeds the dev server's `/readyz` 503 {status:'degraded'} answer.
  describe("settled / degraded() (guuey#770)", () => {
    it("settles at once with nothing to spawn, degraded() empty", async () => {
      handle = spawnColocatedDev([], projectRoot);
      await handle.settled;
      expect(handle.degraded()).toEqual([]);
    });

    it("a child that exits before it ever listens is degraded (and settles)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The ignored-builds fixture dies with exit 1 without binding — the
      // real shape of a colocated install failure.
      handle = spawnColocatedDev(
        [{ name: "my-mcp", source: "fixtures/ignored-builds-child", devPort: 34570 }],
        projectRoot,
      );
      await handle.settled;
      expect(handle.degraded()).toEqual(["my-mcp"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('colocated MCP "my-mcp" is DEGRADED (exited (code 1))'));
      warn.mockRestore();
    });

    it("a child that never listens within readinessTimeoutMs is degraded (and settles)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      markerDir = mkdtempSync(join(tmpdir(), "guuey-colocated-dev-nolisten-"));
      process.env.FIXTURE_MARKER_DIR = markerDir;
      process.env.FIXTURE_NO_LISTEN = "1";
      try {
        handle = spawnColocatedDev(
          [{ name: "sleepy", source: "fixtures/colocated-child", devPort: 34571 }],
          projectRoot,
          { readinessTimeoutMs: 1500 },
        );
        await handle.settled;
        expect(handle.degraded()).toEqual(["sleepy"]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('colocated MCP "sleepy" is DEGRADED (not listening on :34571 within 1500ms)'),
        );
        // The deadline can fire before `pnpm run` has even exec'd the fixture
        // under load; `afterEach` needs the fixture ALIVE to receive stop()'s
        // SIGTERM and write its `stopped` marker — so wait for it here.
        await waitFor(() => existsSync(join(markerDir!, "started")), 10_000);
      } finally {
        delete process.env.FIXTURE_NO_LISTEN;
        warn.mockRestore();
      }
    });

    it("a child that crashes AFTER becoming ready degrades live — locally there is no restart budget", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Own marker dir, cleaned here: the fixture exits on its own, so
      // `afterEach`'s wait for a `stopped` marker would never be satisfied.
      const crashMarkerDir = mkdtempSync(join(tmpdir(), "guuey-colocated-dev-crash-"));
      process.env.FIXTURE_MARKER_DIR = crashMarkerDir;
      // Well past the 200 ms probe interval, so the child is observed READY
      // before it dies even on a loaded box (a crash inside the first probe
      // gap would read as exit-before-ready — a different arm).
      process.env.FIXTURE_CRASH_AFTER_MS = "1200";
      try {
        handle = spawnColocatedDev(
          [{ name: "flaky", source: "fixtures/colocated-child", devPort: 34572 }],
          projectRoot,
        );
        await handle.settled;
        expect(handle.degraded()).toEqual([]);
        await waitFor(() => handle!.degraded().includes("flaky"), 10_000);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('colocated MCP "flaky" is DEGRADED (exited (code 1))'));
      } finally {
        delete process.env.FIXTURE_CRASH_AFTER_MS;
        delete process.env.FIXTURE_MARKER_DIR;
        rmSync(crashMarkerDir, { recursive: true, force: true });
        warn.mockRestore();
      }
    });
  });

  it("skips (with a warning naming the fix) an entry whose package.json has neither a dev nor a start script", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "fixtures" itself has no package.json — resolveScript returns undefined.
    handle = spawnColocatedDev([{ name: "broken", source: "fixtures", devPort: 1 }], projectRoot);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('neither a "dev" nor a "start" script'),
    );
    warn.mockRestore();
  });

  // guuey#120: pnpm ≥11's fatal ignored-builds gate kills fresh colocated
  // installs (tsx → esbuild postinstall) with nothing actionable at the
  // dev-serve level. The fixture emits the marker SPLIT across two stderr
  // chunks (boundary regression) and then again whole (once-only
  // regression) before exiting 1, like the real failure.
  it("prints one targeted onlyBuiltDependencies hint when a child hits ERR_PNPM_IGNORED_BUILDS", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    handle = spawnColocatedDev(
      [{ name: "my-mcp", source: "fixtures/ignored-builds-child", devPort: 34569 }],
      projectRoot,
    );

    await waitFor(() =>
      warn.mock.calls.some((c) => String(c[0]).includes("onlyBuiltDependencies")),
    );
    const hints = warn.mock.calls.filter((c) =>
      String(c[0]).includes("onlyBuiltDependencies"),
    );
    expect(hints).toHaveLength(1);
    expect(String(hints[0]![0])).toContain('colocated MCP "my-mcp" (fixtures/ignored-builds-child)');
    expect(String(hints[0]![0])).toContain('"pnpm": { "onlyBuiltDependencies": ["esbuild"] }');
    // The gate stays intact — the hint must never suggest a blanket allow.
    expect(String(hints[0]![0])).not.toContain("--allow-build");
    warn.mockRestore();
  });

  it("stop() is idempotent (safe to call more than once)", async () => {
    markerDir = mkdtempSync(join(tmpdir(), "guuey-colocated-dev-idempotent-"));
    process.env.FIXTURE_MARKER_DIR = markerDir;

    handle = spawnColocatedDev(
      [{ name: "notes", source: "fixtures/colocated-child", devPort: 34568 }],
      projectRoot,
    );
    await waitFor(() => existsSync(join(markerDir!, "started")));

    expect(() => {
      handle!.stop();
      handle!.stop();
    }).not.toThrow();
  });
});
