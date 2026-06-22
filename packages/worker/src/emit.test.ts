import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createEmitter } from "./emit.js";

function capture(): { out: Writable; lines: () => unknown[] } {
  const chunks: string[] = [];
  const out = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    out,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l)),
  };
}

describe("createEmitter", () => {
  it("writes each event as one NDJSON line", () => {
    const { out, lines } = capture();
    const e = createEmitter(out);
    e.text("hello");
    e.done("final");
    expect(lines()).toEqual([
      { type: "text", text: "hello" },
      { type: "done", stopReason: "end_turn", result: "final" },
    ]);
  });

  it("done defaults stopReason=end_turn", () => {
    const { out, lines } = capture();
    const e = createEmitter(out);
    e.done("ok");
    expect(lines()).toEqual([{ type: "done", stopReason: "end_turn", result: "ok" }]);
  });

  it("error event", () => {
    const { out, lines } = capture();
    createEmitter(out).error("boom");
    expect(lines()).toEqual([{ type: "error", message: "boom" }]);
  });
});
