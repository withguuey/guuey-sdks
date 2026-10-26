/**
 * guuey#2445 — an adoption replaces the rows with history's, and each user
 * row this session sent live keeps its `precedingTurnCount` (matched by the
 * send's `clientMessageId`, or by position when history serves no keys and
 * its user rows are exactly the local ones), so the transcript planner can
 * still tell where the live fold begins.
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

  it("stamps by position when history serves no keys and its user rows are exactly the local ones", () => {
    const history: AgentMessage[] = [
      { role: "user", text: "H0", seq: 1 },
      { role: "assistant", text: "HA0", seq: 2 },
      { role: "user", text: "Q1", seq: 3 },
      { role: "assistant", text: "A1", seq: 4 },
      { role: "user", text: "Q2", seq: 5 },
      { role: "user", text: "Q3", seq: 6 },
      { role: "assistant", text: "A3", seq: 7 },
    ];
    expect(adoptedTranscript(history, local)).toEqual([
      { role: "user", text: "H0", seq: 1 },
      { role: "assistant", text: "HA0", seq: 2 },
      { role: "user", text: "Q1", seq: 3, precedingTurnCount: 0 },
      { role: "assistant", text: "A1", seq: 4 },
      { role: "user", text: "Q2", seq: 5, precedingTurnCount: 1 },
      { role: "user", text: "Q3", seq: 6, precedingTurnCount: 2 },
      { role: "assistant", text: "A3", seq: 7 },
    ]);
  });

  it.each([
    {
      name: "it holds fewer user rows",
      history: [
        { role: "user", text: "Q1", seq: 1 },
        { role: "assistant", text: "A1", seq: 2 },
      ],
    },
    {
      name: "it holds a user row sent elsewhere",
      history: [
        { role: "user", text: "H0", seq: 1 },
        { role: "user", text: "Q1", seq: 2 },
        { role: "user", text: "from another tab", seq: 3 },
        { role: "user", text: "Q2", seq: 4 },
        { role: "user", text: "Q3", seq: 5 },
        { role: "assistant", text: "A3", seq: 6 },
      ],
    },
    {
      name: "a user row's words differ",
      history: [
        { role: "user", text: "H0", seq: 1 },
        { role: "user", text: "Q1", seq: 2 },
        { role: "user", text: "Q2, edited", seq: 3 },
        { role: "user", text: "Q3", seq: 4 },
        { role: "assistant", text: "A3", seq: 5 },
      ],
    },
  ] satisfies Array<{ name: string; history: AgentMessage[] }>)(
    "returns history without keys unchanged when $name",
    ({ history }) => {
      expect(adoptedTranscript(history, local)).toEqual(history);
    },
  );
});
