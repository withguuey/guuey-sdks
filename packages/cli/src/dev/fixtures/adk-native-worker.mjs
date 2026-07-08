#!/usr/bin/env node
// Silver-protocol fixture worker: replays REAL captured Google ADK `Event`s
// (verbatim cassette copy in ./adk-native-events.json, from the silverprotocol
// e2e corpus `single-tool-call/adk.native.json` — functionCall → functionResponse
// → final text) as `native` events, so `dev-server.test.ts` exercises the REAL
// `createAdkNormalizer()` facet end-to-end. Same pattern as
// `claude-native-worker.mjs`, sourcing the shared JSON fixture instead of
// inlining it (normalize.test.ts reads the same file).
import { createInterface } from "node:readline";
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const events = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "adk-native-events.json"), "utf8"),
);
const fd3 = createWriteStream("", { fd: 3 });
const emit = (o) => fd3.write(JSON.stringify(o) + "\n");

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "invoke") continue;
  emit({ type: "hello", framework: "google-adk", sdkName: "@google/adk", sdkVersion: "0.2.0" });
  for (const event of events) emit({ type: "native", framework: "google-adk", event });
  emit({
    type: "done",
    stopReason: "end_turn",
    result: "The message 'conformance-probe' has been echoed back.",
  });
}
