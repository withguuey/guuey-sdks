import { describe, it, expect } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { serveOn } from "./serve.js";
import type { Turn } from "./turn.js";

function harness() {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString("utf8"));
      cb();
    },
  });
  const events = () =>
    chunks
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const send = (obj: unknown) => input.write(JSON.stringify(obj) + "\n");
  return { input, output, events, send };
}

const INVOKE = {
  type: "invoke",
  input: "hi",
  identity: { userId: "u1", authMode: "anonymous" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};

describe("serveOn", () => {
  it("runs a turn: handler text + return → text events then done", async () => {
    const h = harness();
    const done = serveOn(
      async (turn: Turn) => {
        turn.text("part-" + turn.input);
        return "final";
      },
      { input: h.input, output: h.output }
    );
    h.send(INVOKE);
    h.send({ type: "shutdown" });
    await done;
    expect(h.events()).toEqual([
      { type: "text", text: "part-hi" },
      { type: "done", stopReason: "end_turn", result: "final" },
    ]);
  });

  it("a thrown handler becomes an error event (loop survives)", async () => {
    const h = harness();
    const done = serveOn(
      async () => {
        throw new Error("kaboom");
      },
      { input: h.input, output: h.output }
    );
    h.send(INVOKE);
    h.send({ type: "shutdown" });
    await done;
    expect(h.events()).toEqual([{ type: "error", message: "kaboom" }]);
  });

  it("ask blocks until an answer, then resolves the handler", async () => {
    const h = harness();
    const done = serveOn(
      async (turn: Turn) => {
        const tone = await turn.ask("Formal or casual?", { enum: ["formal", "casual"] });
        return `tone=${String(tone)}`;
      },
      { input: h.input, output: h.output }
    );
    h.send(INVOKE);
    // let the ask flush, then answer
    await new Promise((r) => setTimeout(r, 10));
    expect(h.events()).toEqual([
      { type: "ask", prompt: "Formal or casual?", schema: { enum: ["formal", "casual"] } },
    ]);
    h.send({ type: "answer", value: "casual" });
    h.send({ type: "shutdown" });
    await done;
    expect(h.events()).toEqual([
      { type: "ask", prompt: "Formal or casual?", schema: { enum: ["formal", "casual"] } },
      { type: "done", stopReason: "end_turn", result: "tone=casual" },
    ]);
  });

  it("a clean return with no explicit result uses the accumulated text", async () => {
    const h = harness();
    const done = serveOn(
      async (turn: Turn) => {
        turn.text("a");
        turn.text("b");
      },
      { input: h.input, output: h.output }
    );
    h.send(INVOKE);
    h.send({ type: "shutdown" });
    await done;
    expect(h.events().at(-1)).toEqual({ type: "done", stopReason: "end_turn", result: "ab" });
  });

  it("runs multiple sequential turns over one stream", async () => {
    const h = harness();
    const done = serveOn(async (turn: Turn) => turn.input.toUpperCase(), {
      input: h.input,
      output: h.output,
    });
    h.send({ ...INVOKE, input: "one" });
    h.send({ ...INVOKE, input: "two" });
    h.send({ type: "shutdown" });
    await done;
    expect(h.events().filter((e) => e.type === "done")).toEqual([
      { type: "done", stopReason: "end_turn", result: "ONE" },
      { type: "done", stopReason: "end_turn", result: "TWO" },
    ]);
  });
});
