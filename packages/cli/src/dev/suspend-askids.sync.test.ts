/**
 * Sync guard: a worker's `suspend` event names the asks it waits on by their
 * AgJSON `askId`s, and the Router accepts the pause only when those ids equal
 * the paused turn's asks exactly. A worker can name them without running a
 * normalizer only because both approval-capable facets mint them the same way:
 * `approval_<toolCallId>`. This runs the INSTALLED facets (the versions this
 * package depends on) over minimal approval events and pins that convention,
 * so a facet bump that changes it fails here, not in a paused turn.
 */
import { describe, it, expect } from "vitest";
import type { AgEvent } from "@silverprotocol/core";
import { createAdkNormalizer } from "@silverprotocol/google-adk";
import { createOpenaiNormalizer } from "@silverprotocol/openai-agents";

function asks(events: AgEvent[]): Extract<AgEvent, { type: "hitl.ask" }>[] {
  return events.filter((e): e is Extract<AgEvent, { type: "hitl.ask" }> => e.type === "hitl.ask");
}

describe("approval askIds are approval_<toolCallId> in every approval-capable facet", () => {
  it("openai-agents: a tool_approval_requested run item", () => {
    const n = createOpenaiNormalizer({ threadId: "t" });
    const out = [
      ...n.push({
        type: "run_item_stream_event",
        name: "tool_approval_requested",
        item: {
          type: "tool_approval_item",
          rawItem: { type: "function_call", callId: "call_7", name: "send_email", arguments: "{}" },
        },
      }),
      ...n.flush(),
    ];
    const found = asks(out);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "approval", toolCallId: "call_7", askId: "approval_call_7" });
  });

  it("google-adk: requestedToolConfirmations, on the ask and on the paused turn.done", () => {
    const n = createAdkNormalizer({ threadId: "t" });
    const out = [
      ...n.push({
        id: "e1",
        invocationId: "i1",
        author: "agent",
        actions: { requestedToolConfirmations: { "adk-call-7": { hint: "send it?" } } },
      }),
      ...n.flush(),
    ];
    const found = asks(out);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "approval", toolCallId: "adk-call-7", askId: "approval_adk-call-7" });
    const paused = out
      .filter((e): e is Extract<AgEvent, { type: "turn.done" }> => e.type === "turn.done")
      .map((e) => e.outcome);
    expect(paused).toEqual([
      { type: "paused", asks: [expect.objectContaining({ askId: "approval_adk-call-7", toolCallId: "adk-call-7" })] },
    ]);
  });

  it("google-adk: the reserved adk_request_confirmation call names the ask by ITS id, not the original call's", () => {
    const n = createAdkNormalizer({ threadId: "t" });
    const out = [
      ...n.push({
        id: "e1",
        invocationId: "i1",
        author: "agent",
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "adk-confirm-9",
                name: "adk_request_confirmation",
                args: {
                  originalFunctionCall: { id: "adk-orig-1", name: "send_email", args: {} },
                  toolConfirmation: { hint: "send it?" },
                },
              },
            },
          ],
        },
        longRunningToolIds: ["adk-confirm-9"],
      }),
      ...n.flush(),
    ];
    const found = asks(out);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "approval",
      toolCallId: "adk-confirm-9",
      askId: "approval_adk-confirm-9",
    });
  });
});
