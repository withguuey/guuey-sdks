#!/usr/bin/env node
// Silver-protocol fixture worker for ADK host completion (AgJSON §8.0 host obligation 4): the same REAL
// captured Google ADK events as adk-native-worker.mjs (./adk-native-events.json), behind a hello that
// ANNOUNCES the "adk.host-completion" capability, then the host's `__host_complete__` sentinel before done,
// as @guuey/host's ADK runner feeds it. `--no-sentinel` withholds the sentinel: an opted-in router then
// closes the held turn as turn.abort{stream-truncated}, the observable that proves it opted in.
import { createInterface } from "node:readline";
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const events = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "adk-native-events.json"), "utf8"),
);
const sentinel = !process.argv.includes("--no-sentinel");
const fd3 = createWriteStream("", { fd: 3 });
const emit = (o) => fd3.write(JSON.stringify(o) + "\n");

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "invoke") continue;
  emit({
    type: "hello",
    framework: "google-adk",
    sdkName: "@google/adk",
    sdkVersion: "0.2.0",
    capabilities: ["adk.host-completion"],
  });
  for (const event of events) emit({ type: "native", framework: "google-adk", event });
  if (sentinel) emit({ type: "native", framework: "google-adk", event: { type: "__host_complete__" } });
  emit({
    type: "done",
    stopReason: "end_turn",
    result: "The message 'conformance-probe' has been echoed back.",
  });
}
