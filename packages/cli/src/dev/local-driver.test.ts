import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalDriver } from "./local-driver.js";
import type { WorkerEvent } from "@guuey/worker";

const fixture = join(__dirname, "fixtures", "echo-worker.mjs");
const errorFixture = join(__dirname, "fixtures", "error-worker.mjs");
const input = (text: string) => ({
  input: text,
  history: [],
  fs: { app: tmpdir(), home: tmpdir(), session: tmpdir() },
  env: { ...process.env },
  abortSignal: new AbortController().signal,
});

describe("createLocalDriver", () => {
  it("streams hello, native, done from the worker over fd 3", async () => {
    const run = createLocalDriver({ command: process.execPath, args: [fixture] });
    const events: WorkerEvent[] = [];
    for await (const ev of run(input("hi"))) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["hello", "native", "done"]);
    expect(events[2]).toMatchObject({ result: "echo:hi" });
  });

  it("throws on a worker error event", async () => {
    const run = createLocalDriver({ command: process.execPath, args: [errorFixture] });
    await expect(async () => {
      for await (const _ of run(input("x"))) void _;
    }).rejects.toThrow(/worker blew up/);
  });

  it("throws worker-failed-to-start on ENOENT command", async () => {
    const run = createLocalDriver({ command: "/nonexistent-worker-bin", args: [] });
    await expect(async () => {
      for await (const _ of run(input("x"))) void _;
    }).rejects.toThrow(/failed to start/);
  });
});

// guuey#2409: the invoke carries the close offer only when the caller makes it.
describe("createLocalDriver — threadClose offer", () => {
  const endThreadFixture = join(__dirname, "fixtures", "end-thread-worker.mjs");

  it("projects threadClose onto the invoke, so the worker's endThread rides done", async () => {
    const run = createLocalDriver({ command: process.execPath, args: [endThreadFixture] });
    const events: WorkerEvent[] = [];
    for await (const ev of run({ ...input("x"), threadClose: {} })) events.push(ev);
    expect(events.find((e) => e.type === "native")).toMatchObject({ event: { offered: true, answer: "ok" } });
    expect(events.at(-1)).toMatchObject({ type: "done", endThread: { code: "CHAT_FULL" } });
  });

  it("without the offer the worker is told not_offered and done carries no endThread", async () => {
    const run = createLocalDriver({ command: process.execPath, args: [endThreadFixture] });
    const events: WorkerEvent[] = [];
    for await (const ev of run(input("x"))) events.push(ev);
    expect(events.find((e) => e.type === "native")).toMatchObject({ event: { offered: false, answer: "not_offered" } });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done !== undefined && "endThread" in done).toBe(false);
  });
});
