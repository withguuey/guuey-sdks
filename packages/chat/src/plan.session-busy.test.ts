/**
 * SESSION_BUSY: the conversation (or another of the reader's conversations
 * with the same agent) was still answering a message, and the SDK's one retry
 * after the hinted wait met the same answer. Nothing is broken: the kit's own
 * line in place of the transient family's "something went wrong", the
 * family's in-place Retry, and the RETRY tone. Under the widget's verbatim-all
 * posture the pod's own reader sentence shows, on the same retry tone.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import { defaultChatStrings } from "./strings.js";
import type { DisplayItem, ErrorItem, TranscriptInputs, UserMessageItem } from "./types.js";

const LINE = "The agent is still answering a message. Try again in a few seconds.";
/** The pod's busy{active} sentence (nocode-runtime invoke-routing.ts, Appendix A). */
const SOURCE = "This conversation is still answering a message. Try again in a few seconds.";
const widgetPolicy = () => calmPolicy({ error: { verbatim: false, copyByCode: {}, verbatimCodes: "all" } });

function inputsWithError(message: string, code: string | null): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: { message, code },
    prompts: [],
    messages: [],
  };
}

function errorItem(inputs: TranscriptInputs, policy = calmPolicy()): ErrorItem {
  const item = planTranscript(inputs, policy).items.find((i) => i.kind === "error");
  if (item === undefined || item.kind !== "error") throw new Error("no error item planned");
  return item;
}

function userItem(items: readonly DisplayItem[]): UserMessageItem {
  const item = items.find((i) => i.kind === "user");
  if (item === undefined || item.kind !== "user") throw new Error("no user item planned");
  return item;
}

describe("SESSION_BUSY", () => {
  it("the kit's line, exactly", () => {
    expect(defaultChatStrings.errorSessionBusy).toBe(LINE);
  });

  it("plans the kit's line in the transient family, wearing the retry tone, never the family's fault copy", () => {
    const item = errorItem(inputsWithError(SOURCE, "SESSION_BUSY"));
    expect(item.copy).toBe(LINE);
    expect(item.copy).not.toBe(defaultChatStrings.errorTransient);
    expect(item.family).toBe("transient");
    expect(item.tone).toBe("retry");
  });

  it("the widget's verbatim-all posture shows the pod's own sentence, on the retry tone", () => {
    const item = errorItem(inputsWithError(SOURCE, "SESSION_BUSY"), widgetPolicy());
    expect(item.copy).toBe(SOURCE);
    expect(item.tone).toBe("retry");
  });

  it("a builder's string override wins over the default line", () => {
    const policy = calmPolicy({ strings: { ...defaultChatStrings, errorSessionBusy: "Noch beschäftigt." } });
    expect(errorItem(inputsWithError(SOURCE, "SESSION_BUSY"), policy).copy).toBe("Noch beschäftigt.");
  });

  it("refused before admission: the failed bubble carries the kit's line, keeps Retry and wears the retry tone", () => {
    const inputs: TranscriptInputs = {
      ...inputsWithError(SOURCE, "SESSION_BUSY"),
      messages: [{ role: "user", text: "show me Thursday's open slots", clientMessageId: "c2" }],
      sendStates: { c2: "failed" },
    };
    const { items } = planTranscript(inputs, calmPolicy());
    expect(items.filter((i) => i.kind === "error")).toHaveLength(0);
    expect(userItem(items)).toMatchObject({ state: "failed", retry: true, failureLine: LINE, failureTone: "retry" });
  });

  it("the neighbouring 409s stay faults: DUPLICATE_REQUEST and SESSION_CONFLICT carry no tone", () => {
    for (const code of ["DUPLICATE_REQUEST", "SESSION_CONFLICT"]) {
      expect("tone" in errorItem(inputsWithError("x", code)), code).toBe(false);
    }
  });
});
