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
    for await (const ev of readNdjson(Readable.from(splitCharChunks()))) events.push(ev);
    expect(events).toEqual([{ type: "text", text: "5 €" }]);
    expect(JSON.stringify(events)).not.toContain("�");
  });
});
