import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { WorkerEvent } from "@guuey/worker";
import { readNdjson } from "./ndjson.js";

/** An fd-3 text event holding '€' (3 UTF-8 bytes: E2 82 AC), cut after the character's second byte. */
function splitCharChunks(): Buffer[] {
  const bytes = Buffer.from('{"type":"text","text":"5 €"}\n', "utf8");
  const cut = bytes.indexOf(0xe2) + 2;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

describe("readNdjson decodes UTF-8 across chunks", () => {
  it("a 3-byte character split across two chunks survives", async () => {
    const events: WorkerEvent[] = [];
    for await (const ev of readNdjson(Readable.from(splitCharChunks()), () => undefined)) events.push(ev);
    expect(events).toEqual([{ type: "text", text: "5 €" }]);
    expect(JSON.stringify(events)).not.toContain("�");
  });
});

describe("readNdjson skips an event of a type this release does not know (guuey#3434)", () => {
  it("a newer host's event type is handed to onUnknown, never yielded, and reading goes on", async () => {
    const lines = ['{"type":"text","text":"a"}', '{"type":"future_kind","x":1}', '{"type":"done","stopReason":"end_turn","result":"r"}'];
    const events: WorkerEvent[] = [];
    const unknown: string[] = [];
    for await (const ev of readNdjson(Readable.from([`${lines.join("\n")}\n`]), (t) => unknown.push(t))) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(unknown).toEqual(["future_kind"]);
  });

  it("a malformed line still throws", async () => {
    const read = async (): Promise<void> => {
      for await (const _ of readNdjson(Readable.from(["not json\n"]), () => undefined)) void _;
    };
    await expect(read()).rejects.toThrow(/non-JSON event line/);
  });
});
