/**
 * guuey#423 — persisted cards interleave at their TRUE transcript positions
 * when the flat surface carries read-plane seqs; the old tail-always
 * placement + bottom-pin buried a returning visitor's conversation above a
 * stale trailing card. Pins are POSITIONAL (the #306 discipline).
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { TranscriptInputs } from "./types.js";

const CARD = (seq: number) => ({
  seq,
  at: `2026-08-14T0${seq}:00:00Z`,
  cardSnapshot: {
    artifactId: `a${seq}`,
    parts: [
      {
        type: "tool-result",
        toolCallId: `toolu_${seq}`,
        content: [],
        uiData: { resourceUri: `ui://x/${seq}`, uri: `ui://x/${seq}`, mimeType: "text/html", text: "<p>c</p>" },
      },
    ],
  },
});

function inputs(messages: TranscriptInputs["messages"], cards: NonNullable<TranscriptInputs["historyCards"]>): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages,
    historyCards: cards,
    sendStates: {},
    aborted: false,
    adopted: false,
  };
}

describe("guuey#423 — card interleave by seq", () => {
  it("a card seq-between two history turns renders BETWEEN them, not at the tail", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "menu one", seq: 1 },
          { role: "assistant", text: "here", seq: 3 },
          { role: "user", text: "menu two", seq: 5 },
          { role: "assistant", text: "done", seq: 6 },
        ],
        [CARD(4)], // rendered during turn 1's reply — before user turn 2
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    const cardIdx = keys.indexOf("card.4");
    const u1 = keys.indexOf("u1");
    const a0Last = keys.reduce((last, k, i) => (k.startsWith("a0.") ? i : last), -1);
    expect(cardIdx).toBeGreaterThan(a0Last);
    expect(cardIdx).toBeLessThan(u1);
  });

  it("a card newer than every turn keeps the tail (the honest newest case)", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one", seq: 1 },
          { role: "assistant", text: "r", seq: 2 },
        ],
        [CARD(9)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.9")).toBeGreaterThan(keys.indexOf("u0"));
    expect(keys.indexOf("card.9")).toBe(keys.length - 1);
  });

  it("a seq-less (live-only) session keeps the old tail behavior byte-identically", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one" },
          { role: "assistant", text: "r" },
        ],
        [CARD(2)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.2")).toBe(keys.length - 1);
  });

  it("two cards targeting the same slot keep ascending seq order", () => {
    const plan = planTranscript(
      inputs(
        [
          { role: "user", text: "one", seq: 1 },
          { role: "assistant", text: "r", seq: 2 },
          { role: "user", text: "two", seq: 10 },
        ],
        [CARD(4), CARD(6)],
      ),
      calmPolicy(),
      {},
    );
    const keys = plan.items.map((i) => i.key);
    expect(keys.indexOf("card.4")).toBeLessThan(keys.indexOf("card.6"));
    expect(keys.indexOf("card.6")).toBeLessThan(keys.indexOf("u1"));
  });
});

describe("guuey#402 — history-card chip titles (kit half)", () => {
  it("a card carrying toolName titles with the humanized voice; absent keeps the generic fallback", () => {
    const inputs: TranscriptInputs = {
      result: null,
      assistantText: "",
      status: "ready",
      statusElapsedMs: 0,
      activeTool: null,
      error: null,
      prompts: [],
      messages: [],
      sendStates: {},
      aborted: false,
      adopted: false,
      historyCards: [
        {
          seq: 1,
          at: "2026-08-27T00:00:00Z",
          toolName: "mcp__ggui__ggui_render",
          cardSnapshot: {
            parts: [
              { type: "tool-result", toolCallId: "c1", content: [], uiData: { resourceUri: "ui://ggui/render/a/1" } },
            ],
          },
        },
        {
          seq: 2,
          at: "2026-08-27T00:01:00Z",
          cardSnapshot: {
            parts: [
              { type: "tool-result", toolCallId: "c2", content: [], uiData: { resourceUri: "ui://ggui/render/b/2" } },
            ],
          },
        },
      ],
    };
    const plan = planTranscript(inputs, calmPolicy(), {});
    const named = plan.views.find((v) => v.key === "card.1");
    const bare = plan.views.find((v) => v.key === "card.2");
    // The #307 voice layer: ggui rail vocab → end-user words.
    expect(named?.title).toBe("Rendering card");
    // Pre-enabler rows keep the honest generic fallback, never invented.
    expect(bare?.title).toBe(calmPolicy().strings.viewRefFallbackTitle);
  });
});

describe("shared-session re-anchoring (guuey#535 / ggui SPEC §7.1.2.1)", () => {
  /** Two history cards referencing the SAME ui:// resource — the ggui#652
   * amend stamp persisted as a later locator-only reference. */
  const SNAPSHOT_CARD = {
    seq: 2,
    at: "2026-08-30T01:00:00Z",
    cardSnapshot: {
      artifactId: "a-first",
      parts: [
        {
          type: "tool-result",
          toolCallId: "toolu_first",
          content: [],
          uiData: {
            resourceUri: "ui://render/shared-1",
            uri: "ui://render/shared-1",
            mimeType: "text/html",
            text: "<p>frozen snapshot</p>",
          },
        },
      ],
    },
  };
  const LOCATOR_REANCHOR = {
    seq: 6,
    at: "2026-08-30T02:00:00Z",
    cardSnapshot: {
      artifactId: "a-later",
      parts: [
        {
          type: "tool-result",
          toolCallId: "toolu_amend",
          content: [],
          // The ggui#652 stamp shape: {sessionId, resourceUri} in the
          // model channel — locator-only, no mount material.
          structuredContent: { sessionId: "render_f11bb7cb", resourceUri: "ui://render/shared-1" },
        },
      ],
    },
  };

  it("the LATEST reference anchors the surface; the earlier card emits nothing", () => {
    const plan = planTranscript(inputs([], [SNAPSHOT_CARD, LOCATOR_REANCHOR]), calmPolicy());
    const views = plan.items.filter((i) => i.kind === "view");
    expect(views.map((v) => v.key)).toEqual(["card.6"]);
  });

  it("latest wins even when locator-only — the re-fetch restores CURRENT state over the frozen snapshot", () => {
    const plan = planTranscript(inputs([], [SNAPSHOT_CARD, LOCATOR_REANCHOR]), calmPolicy());
    const view = plan.items.find((i) => i.kind === "view");
    if (view?.kind !== "view") throw new Error("no view planned");
    expect(view.channel).toBe("locator");
    expect(view.actionScope).toBe("ui://render/shared-1");
  });

  it("distinct sessions keep distinct cards — dedup is per-scope, never global", () => {
    const other = {
      ...SNAPSHOT_CARD,
      seq: 4,
      cardSnapshot: {
        artifactId: "a-other",
        parts: [
          {
            type: "tool-result",
            toolCallId: "toolu_other",
            content: [],
            uiData: {
              resourceUri: "ui://render/other-2",
              uri: "ui://render/other-2",
              mimeType: "text/html",
              text: "<p>b</p>",
            },
          },
        ],
      },
    };
    const plan = planTranscript(inputs([], [SNAPSHOT_CARD, other, LOCATOR_REANCHOR]), calmPolicy());
    const views = plan.items.filter((i) => i.kind === "view");
    expect(views.map((v) => v.key).sort()).toEqual(["card.4", "card.6"]);
  });
});
