#!/usr/bin/env node
// Keyless fixture worker: emits a hello, then a terminal error event.
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
const fd3 = createWriteStream("", { fd: 3 });
const emit = (o) => fd3.write(JSON.stringify(o) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "invoke") continue;
  emit({ type: "hello", framework: "fixture", sdkName: null, sdkVersion: null });
  emit({ type: "error", message: "worker blew up" });
}
