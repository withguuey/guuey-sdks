import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { verifyWorker } from "./worker.js";

const workerUrl = pathToFileURL(createRequire(import.meta.url).resolve("@guuey/worker")).href;

function writeEntry(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const p = join(dir, "worker.mjs");
  writeFileSync(p, body);
  return p;
}

describe("verifyWorker", () => {
  it("PASSES a conformant @guuey/worker serve() worker", async () => {
    const entry = writeEntry(`
      import { serve } from ${JSON.stringify(workerUrl)};
      serve(async (turn) => { turn.text("ok:" + turn.input); return "done"; });
    `);
    const r = await verifyWorker({ entry, timeoutMs: 10000 });
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.events.some((e) => e.type === "done")).toBe(true);
  });

  it("FAILS a worker that emits garbage on fd 3 (not valid v1 events)", async () => {
    const entry = writeEntry(`
      import fs from "node:fs";
      process.stdin.resume();
      fs.writeSync(3, "this is not json\\n");
      process.exit(0);
    `);
    const r = await verifyWorker({ entry, timeoutMs: 10000 });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.includes("valid v1 events"))?.ok).toBe(false);
  });

  it("FAILS a worker that writes events to STDOUT instead of fd 3 (never reaches done on fd 3)", async () => {
    // Exits IMMEDIATELY (no stdin wait) so fd 3 closes fast — no timeout hang.
    const entry = writeEntry(`
      process.stdout.write(JSON.stringify({type:"done",stopReason:"end_turn",result:"x"})+"\\n");
      process.exit(0);
    `);
    const r = await verifyWorker({ entry, timeoutMs: 10000 });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.name.includes("terminal `done`"))?.ok).toBe(false);
  });
});
