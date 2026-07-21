import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnColocatedDev, type ColocatedDevHandle } from "./colocated-dev.js";

const projectRoot = __dirname;

let handle: ColocatedDevHandle | undefined;
let markerDir: string | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
  if (markerDir) {
    delete process.env.FIXTURE_MARKER_DIR;
    rmSync(markerDir, { recursive: true, force: true });
    markerDir = undefined;
  }
});

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

describe("spawnColocatedDev", () => {
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
