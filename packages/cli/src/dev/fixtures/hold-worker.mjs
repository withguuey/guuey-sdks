#!/usr/bin/env node
// Keyless fixture worker for the dev server's DRAIN tests (guuey#770): like
// `echo-worker.mjs`, but HOLDS the turn open — after the native echo event it
// polls for the release marker file named by `HOLD_WORKER_RELEASE` (env) and
// emits `done` only once it exists. That gives a test a turn that is
// deterministically in flight (no sleeps to race) while it asserts what
// `/readyz` and a second invoke answer mid-drain, and a switch to end it.
import { createInterface } from "node:readline";
import { createWriteStream, existsSync } from "node:fs";
const fd3 = createWriteStream("", { fd: 3 });
const emit = (o) => fd3.write(JSON.stringify(o) + "\n");
const release = process.env.HOLD_WORKER_RELEASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "invoke") continue;
  emit({ type: "hello", framework: "fixture", sdkName: null, sdkVersion: null });
  emit({
    type: "native",
    framework: "fixture",
    event: { echo: msg.input, user: msg.identity.userId },
  });
  if (release) {
    while (!existsSync(release)) await sleep(25);
  }
  emit({ type: "done", stopReason: "end_turn", result: `echo:${msg.input}` });
}
