/**
 * The host's handling of one fd-0 control line (guuey#3434): nothing a newer Router sends, and nothing malformed,
 * ends the host. Each case is read the way the loop in index.ts reads it: line by line, in order.
 */
import { describe, expect, it } from "vitest";
import { CONTROL_NOTE_TYPE_MAX, readControlLine, type ControlStep } from "./control-line.js";

const INVOKE = {
  type: "invoke",
  input: "hi",
  identity: { userId: "u", authMode: "authenticated" },
  fs: { app: "/app", home: "/home", session: "/session" },
  history: [],
};

/** The loop's own reading of a stream of lines: each step, until a shutdown. */
function run(lines: readonly string[]): ControlStep[] {
  const steps: ControlStep[] = [];
  for (const line of lines) {
    const step = readControlLine(line);
    steps.push(step);
    if (step.kind === "shutdown") break;
  }
  return steps;
}

describe("readControlLine: a NEWER Router's control type (N−1)", () => {
  it("is skipped with a note naming its type, and the next invoke still runs a turn", () => {
    const steps = run([JSON.stringify({ type: "cancel", turnId: "t1" }), JSON.stringify(INVOKE)]);
    expect(steps.map((s) => s.kind)).toEqual(["skip", "invoke"]);
    expect(steps[0]).toEqual({ kind: "skip", note: '[guuey] skipped a control line of unknown type "cancel"' });
    const turn = steps[1];
    expect(turn?.kind === "invoke" ? turn.invoke.input : undefined).toBe("hi");
  });

  it("names at most CONTROL_NOTE_TYPE_MAX characters of the type", () => {
    const step = readControlLine(JSON.stringify({ type: "x".repeat(500) }));
    expect(step).toEqual({ kind: "skip", note: `[guuey] skipped a control line of unknown type "${"x".repeat(CONTROL_NOTE_TYPE_MAX)}"` });
  });

  it("a shutdown after it still ends the loop", () => {
    expect(run([JSON.stringify({ type: "ping" }), JSON.stringify({ type: "shutdown" }), JSON.stringify(INVOKE)]).map((s) => s.kind)).toEqual([
      "skip",
      "shutdown",
    ]);
  });
});

describe("readControlLine: a line that is not a usable control message", () => {
  it("non-JSON is skipped without quoting it", () => {
    const step = readControlLine("secret-token-abc not json");
    expect(step).toEqual({ kind: "skip", note: "[guuey] skipped a control line that is not JSON" });
  });

  it("a JSON non-object is skipped without quoting it", () => {
    expect(readControlLine('"secret-token-abc"')).toEqual({ kind: "skip", note: "[guuey] skipped a control line that is not a JSON object" });
    expect(readControlLine("[1,2]")).toEqual({ kind: "skip", note: "[guuey] skipped a control line that is not a JSON object" });
  });

  it("an object with no string type is skipped without quoting it", () => {
    expect(readControlLine(JSON.stringify({ input: "secret-token-abc" }))).toEqual({
      kind: "skip",
      note: "[guuey] skipped a control line with no string type",
    });
  });

  it("a malformed invoke is refused with one error naming the field, and the next invoke still runs", () => {
    const steps = run([JSON.stringify({ type: "invoke", input: "secret-token-abc" }), JSON.stringify(INVOKE)]);
    expect(steps.map((s) => s.kind)).toEqual(["refuse", "invoke"]);
    const refused = steps[0];
    expect(refused?.kind).toBe("refuse");
    if (refused?.kind === "refuse") {
      expect(refused.error).toMatch(/^@guuey\/host: invoke refused: invoke/);
      expect(refused.error).not.toContain("secret-token-abc");
      expect(refused.note).not.toContain("secret-token-abc");
    }
  });

  it("no note ever carries the line's bytes", () => {
    for (const line of ["secret-token-abc", '"secret-token-abc"', JSON.stringify({ secret: "secret-token-abc" })]) {
      const step = readControlLine(line);
      expect(JSON.stringify(step)).not.toContain("secret-token-abc");
    }
  });
});

describe("readControlLine: the lines it always understood", () => {
  it("shutdown and a valid invoke are unchanged", () => {
    expect(readControlLine(JSON.stringify({ type: "shutdown" }))).toEqual({ kind: "shutdown" });
    const step = readControlLine(JSON.stringify(INVOKE));
    expect(step.kind).toBe("invoke");
  });
});
