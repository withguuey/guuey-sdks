/**
 * A view item carries its card's tool data — the producing call's arguments
 * and the tool's result — so the view host can send the spec's
 * `ui/notifications/tool-input` and `ui/notifications/tool-result` after the
 * view's `initialized`. Live cards read the fold's call + result; history
 * cards read the stored snapshot (result only: the projection stores no call).
 */
import { describe, expect, it } from "vitest";
import type { AgReduceResult, JsonValue } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs, ViewMountItem } from "./types.js";

function inputs(result: AgReduceResult | null, historyCards: TranscriptInputs["historyCards"] = []): TranscriptInputs {
  return {
    result,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [{ role: "user", text: "forecast please" }],
    historyCards,
  };
}

function fold(input: JsonValue): AgReduceResult {
  return {
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", name: "forecast", input },
          {
            type: "tool-result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "Forecast ready." }],
            uiData: { resourceUri: "ui://weather/forecast", temps: [21, 23] },
          },
        ],
      },
    ],
    artifacts: [],
    memory: [],
    turns: [],
  };
}

const views = (i: TranscriptInputs): ViewMountItem[] =>
  planTranscript(i, calmPolicy()).items.filter((item): item is ViewMountItem => item.kind === "view");

describe("view items carry the card's tool data", () => {
  it("a live card: the call's arguments + the result's surface data and text", () => {
    const [view] = views(inputs(fold({ city: "Lisbon" })));
    expect(view?.toolData).toEqual({
      input: { city: "Lisbon" },
      result: {
        content: [{ type: "text", text: "Forecast ready." }],
        structuredContent: { resourceUri: "ui://weather/forecast", temps: [21, 23] },
      },
    });
  });

  it("a live card whose stored input was elided: no input, the result still rides", () => {
    const [view] = views(inputs(fold({ "com.guuey/elided": { bytes: 200_000 } })));
    expect(view?.toolData?.input).toBeUndefined();
    expect(view?.toolData?.result?.structuredContent).toEqual({ resourceUri: "ui://weather/forecast", temps: [21, 23] });
  });

  it("a history card: the stored result, and no input (none is stored)", () => {
    const [view] = views(
      inputs(null, [
        {
          seq: 4,
          at: "2026-10-01T00:00:04Z",
          cardSnapshot: {
            artifactId: "m#ui#0",
            parts: [
              {
                type: "tool-result",
                toolCallId: "call-9",
                content: [],
                uiData: { resourceUri: "ui://weather/forecast", temps: [19] },
              },
            ],
          },
        },
      ]),
    );
    expect(view?.toolData).toEqual({
      result: { content: [], structuredContent: { resourceUri: "ui://weather/forecast", temps: [19] } },
    });
  });
});
