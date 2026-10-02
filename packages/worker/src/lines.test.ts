import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { lines } from "./lines.js";

/** A line holding '€' (3 UTF-8 bytes: E2 82 AC), cut after the character's second byte. */
function splitCharChunks(): Buffer[] {
  const bytes = Buffer.from('{"type":"invoke","input":"5 €"}\n', "utf8");
  const cut = bytes.indexOf(0xe2) + 2;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

describe("lines — the control-stream reader decodes UTF-8 across chunks", () => {
  it("a 3-byte character split across two chunks survives", async () => {
    const out: string[] = [];
    for await (const line of lines(Readable.from(splitCharChunks()))) out.push(line);
    expect(out).toEqual(['{"type":"invoke","input":"5 €"}']);
    expect(out.join("")).not.toContain("�");
  });

  it("a split character in a trailing line with no newline survives too", async () => {
    const [a, b] = splitCharChunks();
    const noNewline = b!.subarray(0, b!.length - 1);
    const out: string[] = [];
    for await (const line of lines(Readable.from([a!, noNewline]))) out.push(line);
    expect(out).toEqual(['{"type":"invoke","input":"5 €"}']);
  });
});
