/**
 * guuey#2355 — a conversation the agent ended. The plan carries the closure
 * (`plan.threadClosed`) so a renderer can draw the closed state, and voices
 * the agent's message ONCE: the live error item and the reloaded notice row
 * that carry the closing code are not drawn beside it.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@guuey/agent-client";
import { transcriptInputsFromHistory } from "./history-inputs.js";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs } from "./types.js";

const CLOSED = { code: "app:CHAT_FULL", message: "This chat is full. Start a new one.", closedAt: "2026-10-15T00:00:00.000Z" };

function liveInputs(over: Partial<TranscriptInputs>): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [{ role: "user", text: "hi" }],
    ...over,
  };
}

describe("planTranscript: threadClosed", () => {
  it("an open conversation plans threadClosed null", () => {
    expect(planTranscript(liveInputs({}), calmPolicy()).threadClosed).toBeNull();
  });

  it("live: carries the closure and draws no error item for the closing code", () => {
    const plan = planTranscript(
      liveInputs({ error: { message: CLOSED.message, code: CLOSED.code }, threadClosed: CLOSED }),
      calmPolicy(),
    );
    expect(plan.threadClosed).toEqual({ code: CLOSED.code, message: CLOSED.message });
    expect(plan.items.some((i) => i.kind === "error")).toBe(false);
  });

  it("live: an error with a DIFFERENT code beside the closure is still drawn", () => {
    const plan = planTranscript(
      liveInputs({ error: { message: "boom", code: "PLATFORM_ERROR" }, threadClosed: CLOSED }),
      calmPolicy(),
    );
    expect(plan.items.some((i) => i.kind === "error")).toBe(true);
  });

  it("reopen: the closing notice row is not drawn; other notices are", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: "Something failed.", seq: 2, failure: { code: "NO_REPLY" } },
      { role: "user", text: "q2", seq: 3 },
      { role: "notice", text: CLOSED.message, seq: 4, failure: { code: CLOSED.code } },
    ];
    const plan = planTranscript(transcriptInputsFromHistory({ messages, closed: CLOSED }), calmPolicy());
    expect(plan.threadClosed).toEqual({ code: CLOSED.code, message: CLOSED.message });
    const notices = plan.items.filter((i) => i.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ failure: { code: "NO_REPLY" } });
  });

  it("reopen without a closure keeps the app: notice row (nothing to voice it otherwise)", () => {
    const messages: AgentMessage[] = [
      { role: "user", text: "q", seq: 1 },
      { role: "notice", text: CLOSED.message, seq: 2, failure: { code: CLOSED.code } },
    ];
    const plan = planTranscript(transcriptInputsFromHistory({ messages }), calmPolicy());
    expect(plan.threadClosed).toBeNull();
    expect(plan.items.filter((i) => i.kind === "notice")).toHaveLength(1);
  });
});
