import { describe, expect, it } from "vitest";
import { stallProbeDecision } from "./useAgentInvoke.js";
import type { AgentMessage } from "./types.js";

const user = (text: string): AgentMessage => ({ role: "user", text });

describe("stallProbeDecision — a finished tail", () => {
  it("adopts a history whose last row is the turn's notice: a failed turn ends on it (persisted at completion)", () => {
    expect(stallProbeDecision([user("q"), { role: "notice", text: "The reply was withheld.", failure: { code: "CONTENT_BLOCKED" } }], 1)).toBe("adopt");
  });

  it("RED control: an assistant tail adopts, a user tail or an empty tail stays in flight, as before", () => {
    expect(stallProbeDecision([user("q"), { role: "assistant", text: "Here it is." }], 1)).toBe("adopt");
    expect(stallProbeDecision([user("q")], 1)).toBe("in-flight");
    expect(stallProbeDecision([user("q"), { role: "notice", text: " " }], 1)).toBe("in-flight");
    expect(stallProbeDecision([user("q"), { role: "assistant", text: "old" }], 2)).toBe("in-flight");
  });
});

/**
 * guuey#2858: a history read can stop at its page cap, and then it does not
 * hold every row, so "history holds as many user turns as the local
 * transcript" cannot hold. A keyed history finds the turn by its key; a
 * keyless one keeps the count rule only when the read was whole.
 *
 * RED controls: read the whole-conversation count rule on a truncated read and
 * the truncated keyed adopt fails; skip the window rule and the never-stored
 * cm-2 is adopted over; drop the `holdsNewest` gate and the ascending cases
 * adopt.
 */
describe("stallProbeDecision — the turn by its key, and a truncated read (guuey#2858)", () => {
  const keyed = (text: string, clientMessageId: string): AgentMessage => ({ role: "user", text, clientMessageId });

  it("a truncated keyed history adopts THIS turn's finished reply although it holds fewer user turns than the local transcript", () => {
    const history: AgentMessage[] = [keyed("q9", "cm-9"), { role: "assistant", text: "a9" }, keyed("q10", "cm-10"), { role: "assistant", text: "a10" }];
    // The local transcript: eight older turns the read left out, then the two it holds.
    const localRows: AgentMessage[] = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n): AgentMessage[] => [keyed(`q${n}`, `cm-${n}`), { role: "assistant", text: `a${n}` }]),
      keyed("q9", "cm-9"),
      { role: "assistant", text: "a9" },
      keyed("q10", "cm-10"),
      { role: "assistant", text: "" },
    ];
    expect(stallProbeDecision(history, 10, { clientMessageId: "cm-10", truncated: true, order: "desc", localRows })).toBe("adopt");
    // Without the local rows the window cannot be placed: not adopted.
    expect(stallProbeDecision(history, 10, { clientMessageId: "cm-10", truncated: true, order: "desc" })).toBe("in-flight");
  });

  it("a keyed history without this turn's row is in flight, even when its tail is a finished reply", () => {
    const history: AgentMessage[] = [keyed("q9", "cm-9"), { role: "assistant", text: "a9" }];
    expect(stallProbeDecision(history, 1, { clientMessageId: "cm-10" })).toBe("in-flight");
  });

  it("a keyed history holding this turn's row but no reply after it is in flight", () => {
    expect(stallProbeDecision([keyed("q", "cm-1")], 1, { clientMessageId: "cm-1" })).toBe("in-flight");
    expect(stallProbeDecision([keyed("q", "cm-1"), { role: "assistant", text: "  " }], 1, { clientMessageId: "cm-1" })).toBe("in-flight");
  });

  it("the turn ends at the next user row: a later send's reply is not this turn's", () => {
    const history: AgentMessage[] = [keyed("q1", "cm-1"), keyed("q2", "cm-2"), { role: "assistant", text: "a2" }];
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-1" })).toBe("in-flight");
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-2" })).toBe("adopt");
  });

  it("a keyed history holding fewer user turns than the local transcript is in flight when a local send inside its window was never stored, whole or truncated", () => {
    const history: AgentMessage[] = [keyed("q1", "cm-1"), { role: "assistant", text: "a1" }, keyed("q3", "cm-3"), { role: "assistant", text: "a3" }];
    // cm-2 failed before admission: it stays local (with its Retry) and the read plane never stored it.
    const localRows: AgentMessage[] = [
      keyed("q1", "cm-1"),
      { role: "assistant", text: "a1" },
      { ...keyed("q2", "cm-2"), precedingTurnCount: 1 },
      { ...keyed("q3", "cm-3"), precedingTurnCount: 1 },
      { role: "assistant", text: "" },
    ];
    expect(stallProbeDecision(history, 3, { clientMessageId: "cm-3" })).toBe("in-flight");
    expect(stallProbeDecision(history, 3, { clientMessageId: "cm-3", truncated: true, order: "desc", localRows })).toBe("in-flight");
  });

  it("a truncated keyed history adopts when every local send it does not hold is older than its oldest row", () => {
    const history: AgentMessage[] = [keyed("q1", "cm-1"), { role: "assistant", text: "a1" }, keyed("q3", "cm-3"), { role: "assistant", text: "a3" }];
    const localRows: AgentMessage[] = [
      keyed("q0", "cm-0"),
      { role: "assistant", text: "a0" },
      keyed("q1", "cm-1"),
      { role: "assistant", text: "a1" },
      { ...keyed("q3", "cm-3"), precedingTurnCount: 1 },
      { role: "assistant", text: "" },
    ];
    expect(stallProbeDecision(history, 3, { clientMessageId: "cm-3", truncated: true, order: "desc", localRows })).toBe("adopt");
  });

  it("a truncated ASCENDING keyed read whose turn runs to its end is in flight: the turn's last rows may lie past the cut", () => {
    const history: AgentMessage[] = [keyed("q1", "cm-1"), { role: "assistant", text: "a1" }, keyed("q2", "cm-2"), { role: "assistant", text: "a2 part" }];
    const localRows: AgentMessage[] = [...history.slice(0, 3), { role: "assistant", text: "" }];
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-2", truncated: true, order: "asc", localRows })).toBe("in-flight");
    // The same read newest-first holds the newest row, so the turn is whole.
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-2", truncated: true, order: "desc", localRows })).toBe("adopt");
    // A turn the next user row closes is whole even on an ascending read.
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-1", truncated: true, order: "asc", localRows: history })).toBe("adopt");
  });

  it("a keyless truncated ASCENDING history is pending (in flight), never adopted, even with a finished tail and enough user turns", () => {
    const history: AgentMessage[] = [user("q"), { role: "assistant", text: "a" }];
    expect(stallProbeDecision(history, 1, { clientMessageId: "cm-1", truncated: true, order: "asc" })).toBe("in-flight");
    // A loader that does not say its order is read as ascending.
    expect(stallProbeDecision(history, 1, { clientMessageId: "cm-1", truncated: true })).toBe("in-flight");
  });

  it("a keyless history that holds the newest row (whole, or truncated newest-first) keeps the positional rule", () => {
    const history: AgentMessage[] = [user("q"), { role: "assistant", text: "a" }];
    expect(stallProbeDecision(history, 1, { clientMessageId: "cm-1", truncated: true, order: "desc" })).toBe("adopt");
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-1", truncated: true, order: "desc" })).toBe("in-flight");
    expect(stallProbeDecision(history, 1, { clientMessageId: "cm-1" })).toBe("adopt");
    expect(stallProbeDecision(history, 2, { clientMessageId: "cm-1" })).toBe("in-flight");
  });
});
