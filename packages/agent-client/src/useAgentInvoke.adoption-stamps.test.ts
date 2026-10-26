/**
 * guuey#2445 — an adoption replaces the rows with history's, and each user
 * row this session sent live keeps its `precedingTurnCount` (matched by the
 * send's `clientMessageId`), so the transcript planner can still tell where
 * the live fold begins.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "./types.js";
import { adoptedTranscript } from "./useAgentInvoke.js";

describe("adoptedTranscript", () => {
  const local: AgentMessage[] = [
    { role: "user", text: "H0", seq: 1 },
    { role: "assistant", text: "HA0", seq: 2 },
    { role: "user", text: "Q1", clientMessageId: "cm-1", precedingTurnCount: 0 },
    { role: "assistant", text: "A1" },
    { role: "user", text: "Q2", clientMessageId: "cm-2", precedingTurnCount: 1 },
    { role: "user", text: "Q3", clientMessageId: "cm-3", precedingTurnCount: 2 },
    { role: "assistant", text: "" },
  ];

  it("stamps each history user row whose key a live row carried, and leaves every other row as history has it", () => {
    const history: AgentMessage[] = [
      { role: "user", text: "H0", seq: 1, clientMessageId: "cm-old" },
      { role: "assistant", text: "HA0", seq: 2 },
      { role: "user", text: "Q1", seq: 3, clientMessageId: "cm-1" },
      { role: "assistant", text: "A1", seq: 4 },
      { role: "user", text: "Q2", seq: 5, clientMessageId: "cm-2" },
      { role: "user", text: "Q3", seq: 6, clientMessageId: "cm-3" },
      { role: "assistant", text: "A3", seq: 7 },
    ];
    expect(adoptedTranscript(history, local)).toEqual([
      { role: "user", text: "H0", seq: 1, clientMessageId: "cm-old" },
      { role: "assistant", text: "HA0", seq: 2 },
      { role: "user", text: "Q1", seq: 3, clientMessageId: "cm-1", precedingTurnCount: 0 },
      { role: "assistant", text: "A1", seq: 4 },
      { role: "user", text: "Q2", seq: 5, clientMessageId: "cm-2", precedingTurnCount: 1 },
      { role: "user", text: "Q3", seq: 6, clientMessageId: "cm-3", precedingTurnCount: 2 },
      { role: "assistant", text: "A3", seq: 7 },
    ]);
  });

  it("returns history unchanged when its rows carry no key (a read plane that does not serve it)", () => {
    const history: AgentMessage[] = [
      { role: "user", text: "Q1", seq: 1 },
      { role: "assistant", text: "A1", seq: 2 },
    ];
    expect(adoptedTranscript(history, local)).toEqual(history);
  });
});
