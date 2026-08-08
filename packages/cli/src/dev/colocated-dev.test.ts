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
  if (markerDir) {
    await waitForStoppedMarker(markerDir);
  }
  handle = undefined;
  if (markerDir) {
    delete process.env.FIXTURE_MARKER_DIR;
    rmSync(markerDir, { recursive: true, force: true });
    markerDir = undefined;
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
  it("spawns the entry's dev script with PORT set in its env, and stop() SIGTERMs it", async () => {
    markerDir = mkdtempSync(join(tmpdir(), "guuey-colocated-dev-"));
    process.env.FIXTURE_MARKER_DIR = markerDir;

    handle = spawnColocatedDev(
      [{ name: "notes", source: "fixtures/colocated-child", devPort: 34567 }],
      projectRoot,
    );

    await waitFor(() => existsSync(join(markerDir!, "started")));
    expect(readFileSync(join(markerDir!, "started"), "utf8")).toBe("PORT=34567");

    handle.stop();
    await waitFor(() => existsSync(join(markerDir!, "stopped")));
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
