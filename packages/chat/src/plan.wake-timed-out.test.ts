/**
 * guuey#2453 — a sleeping app that did not wake within the SDK's wake budget
 * (`WAKE_TIMED_OUT`, minted by `@guuey/agent-client`). Nothing is broken, it
 * was only slow: the kit's own line, the transient family's in-place Retry,
 * and the RETRY tone (no error tint) on the error item. Every other code keeps
 * the fault tone. The SDK's error carries the same sentence the kit shows
 * (`WAKE_TIMED_OUT_MESSAGE`, its one home), so `verbatimCodes: "all"` needs no
 * exception for it.
 */
import { describe, expect, it } from "vitest";
import { WAKE_TIMED_OUT_MESSAGE } from "@guuey/agent-client";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import { defaultChatStrings } from "./strings.js";
import type { DisplayItem, ErrorItem, TranscriptInputs, UserMessageItem } from "./types.js";

const LINE = "This agent didn't wake up in time. Please try again.";
/** What the SDK's `WakeTimedOutError` carries when the wake budget runs out. */
const SOURCE = WAKE_TIMED_OUT_MESSAGE;
/** A single waking refusal with no budget behind it (`coldStartRetry: false`): code-less, the bare status line. */
const RAW = "agent responded 503";
/** The widget's posture (guuey#162): every source message verbatim. */
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

describe("guuey#2453: WAKE_TIMED_OUT", () => {
  it("the kit's line, exactly, and its default is the SDK's one sentence", () => {
    expect(defaultChatStrings.errorWakeTimedOut).toBe(LINE);
    expect(defaultChatStrings.errorWakeTimedOut).toBe(WAKE_TIMED_OUT_MESSAGE);
  });

  it("plans the kit's line in the transient family, wearing the retry tone", () => {
    const item = errorItem(inputsWithError(SOURCE, "WAKE_TIMED_OUT"));
    expect(item.copy).toBe(LINE);
    expect(item.family).toBe("transient");
    expect(item.tone).toBe("retry");
  });

  it("every other code, and a code-less error, is a fault: no tone at all (one convention with failureTone)", () => {
    for (const code of ["POD_SATURATED", "QUOTA_EXCEEDED", "UNAUTHORIZED", "STREAM_STALLED", "TIMEOUT", null]) {
      expect("tone" in errorItem(inputsWithError("x", code)), String(code)).toBe(false);
    }
  });

  it("the widget's verbatim-all posture shows the source, which is the same sentence: one rule, no exception", () => {
    const item = errorItem(inputsWithError(SOURCE, "WAKE_TIMED_OUT"), widgetPolicy());
    expect(item.copy).toBe(LINE);
    expect(item.copy).not.toContain("503");
    expect(item.tone).toBe("retry");
  });

  it("the widget's verbatim-all posture: a code-less 503 (a waking refusal with no budget behind it) reads its source on the fault tone", () => {
    const item = errorItem(inputsWithError(RAW, null), widgetPolicy());
    expect(item.copy).toBe(RAW);
    expect(item.family).toBe("transient");
    expect("tone" in item).toBe(false);
  });

  it("a host's own sentence and an explicit verbatim listing still win (explicit host intent)", () => {
    const own = calmPolicy({ error: { verbatim: false, copyByCode: { WAKE_TIMED_OUT: "Still asleep." }, verbatimCodes: "all" } });
    expect(errorItem(inputsWithError(SOURCE, "WAKE_TIMED_OUT"), own).copy).toBe("Still asleep.");
    const listed = calmPolicy({ error: { verbatim: false, copyByCode: {}, verbatimCodes: ["WAKE_TIMED_OUT"] } });
    expect(errorItem(inputsWithError("source words", "WAKE_TIMED_OUT"), listed).copy).toBe("source words");
  });

  it("verbatim-all still renders the source for other codes", () => {
    expect(errorItem(inputsWithError("source words", "THREAD_HISTORY_UNAVAILABLE"), widgetPolicy()).copy).toBe("source words");
  });

  it("a builder's string override wins over the default line", () => {
    const policy = calmPolicy({ strings: { ...defaultChatStrings, errorWakeTimedOut: "Schläft noch." } });
    expect(errorItem(inputsWithError(SOURCE, "WAKE_TIMED_OUT"), policy).copy).toBe("Schläft noch.");
  });

  it("debug keeps the code-prefixed raw line beside the kit's line", () => {
    const item = errorItem(inputsWithError(SOURCE, "WAKE_TIMED_OUT"), debugPolicy());
    expect(item.verbatim).toBe(`WAKE_TIMED_OUT: ${SOURCE}`);
    expect(item.tone).toBe("retry");
  });

  it("refused before admission: the failed bubble carries the kit's line and keeps Retry, even under verbatim-all", () => {
    const inputs: TranscriptInputs = {
      ...inputsWithError(SOURCE, "WAKE_TIMED_OUT"),
      messages: [{ role: "user", text: "hello", clientMessageId: "c1" }],
      sendStates: { c1: "failed" },
    };
    for (const policy of [calmPolicy(), widgetPolicy()]) {
      const { items } = planTranscript(inputs, policy);
      expect(items.filter((i) => i.kind === "error")).toHaveLength(0);
      expect(userItem(items)).toMatchObject({ state: "failed", retry: true, failureLine: LINE });
    }
  });

  it("the live turn: the refused bubble wears the retry tone beside the kit's line and its Retry", () => {
    const user = userItem(planTranscript(refused("WAKE_TIMED_OUT"), widgetPolicy()).items);
    expect(user).toMatchObject({ state: "failed", retry: true, failureLine: LINE, failureTone: "retry" });
  });

  it("a refused bubble for any other code carries no tone (it draws as before)", () => {
    for (const code of ["DRAINING", "POD_SATURATED", "QUOTA_EXCEEDED", null]) {
      expect("failureTone" in userItem(planTranscript(refused(code), calmPolicy()).items), String(code)).toBe(false);
    }
  });
});

/** A send refused before admission: the latest user row is `failed`. */
function refused(code: string | null): TranscriptInputs {
  return {
    ...inputsWithError(code === "WAKE_TIMED_OUT" ? SOURCE : RAW, code),
    messages: [{ role: "user", text: "hello", clientMessageId: "c1" }],
    sendStates: { c1: "failed" },
  };
}
