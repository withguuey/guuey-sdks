/**
 * guuey#2604 — a send refused before admission is ONE state: the failed
 * bubble carries the turn's coded line, and R11 draws no second box for it.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { DisplayItem, TranscriptInputs, UserMessageItem } from "./types.js";

function inputs(
  code: string | null,
  sendState: "sending" | "sent" | "failed",
  message = "pod envelope text",
): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: { message, code },
    prompts: [],
    messages: [{ role: "user", text: "hello", clientMessageId: "c1" }],
    // An admitted send drops out of the ledger: absent reads as "sent".
    sendStates: sendState === "sent" ? {} : { c1: sendState },
  };
}

function userItem(items: readonly DisplayItem[]): UserMessageItem {
  const item = items.find((i) => i.kind === "user");
  if (item === undefined || item.kind !== "user") throw new Error("no user item planned");
  return item;
}

const errorItems = (items: readonly DisplayItem[]) => items.filter((i) => i.kind === "error");

describe("guuey#2604: a refused send is one state", () => {
  it("POD_SATURATED: no error item; the bubble carries the busy line and keeps Retry", () => {
    const policy = calmPolicy();
    const { items } = planTranscript(inputs("POD_SATURATED", "failed"), policy);
    expect(errorItems(items)).toHaveLength(0);
    expect(userItem(items)).toMatchObject({
      state: "failed",
      retry: true,
      failureLine: policy.strings.errorPodSaturated,
    });
  });

  it("DRAINING: no error item; the bubble carries the restarting line, never the pod's envelope", () => {
    const policy = calmPolicy();
    const { items } = planTranscript(inputs("DRAINING", "failed"), policy);
    expect(errorItems(items)).toHaveLength(0);
    const user = userItem(items);
    expect(user.failureLine).toBe(policy.strings.errorDraining);
    expect(user.failureLine).not.toContain("pod");
    expect(user.retry).toBe(true);
  });

  it("a code-less refusal: no error item, no line (the renderer's couldn't-send), Retry offered", () => {
    const { items } = planTranscript(inputs(null, "failed"), calmPolicy());
    expect(errorItems(items)).toHaveLength(0);
    const user = userItem(items);
    expect(user.failureLine).toBeUndefined();
    expect(user.retry).toBe(true);
  });

  it("an unknown code reads as transient: no line, Retry offered", () => {
    const { items } = planTranscript(inputs("SOMETHING_NEW", "failed"), calmPolicy());
    expect(errorItems(items)).toHaveLength(0);
    expect(userItem(items)).toMatchObject({ retry: true });
    expect(userItem(items).failureLine).toBeUndefined();
  });

  it("QUOTA_EXCEEDED: the family's sentence on the bubble, and no Retry the same send would meet again", () => {
    const policy = calmPolicy();
    const { items } = planTranscript(inputs("QUOTA_EXCEEDED", "failed"), policy);
    expect(errorItems(items)).toHaveLength(0);
    expect(userItem(items)).toMatchObject({ retry: false, failureLine: policy.strings.errorQuota });
  });

  it("UNAUTHORIZED: the sign-in sentence on the bubble, no Retry", () => {
    const policy = calmPolicy();
    const { items } = planTranscript(inputs("UNAUTHORIZED", "failed"), policy);
    expect(userItem(items)).toMatchObject({ retry: false, failureLine: policy.strings.errorAuth });
  });

  it("the host's copyByCode wins on the bubble line too", () => {
    const policy = calmPolicy({ error: { copyByCode: { POD_SATURATED: "Busy — try again soon." } } });
    const { items } = planTranscript(inputs("POD_SATURATED", "failed"), policy);
    expect(userItem(items).failureLine).toBe("Busy — try again soon.");
  });

  it("a host's verbatim opt-in puts the pod's sentence on the bubble", () => {
    const policy = calmPolicy({ error: { verbatimCodes: ["DRAINING"] } });
    const { items } = planTranscript(inputs("DRAINING", "failed", "Restarting, back shortly."), policy);
    expect(userItem(items).failureLine).toBe("Restarting, back shortly.");
  });

  it("an admitted turn's error keeps its R11 item, and the bubble carries no line", () => {
    for (const state of ["sent", "sending"] as const) {
      const { items } = planTranscript(inputs("POD_SATURATED", state), calmPolicy());
      expect(errorItems(items)).toHaveLength(1);
      expect(userItem(items).failureLine).toBeUndefined();
    }
  });

  it("only the LATEST send is voiced: an earlier failed bubble keeps the plain line and the error item stays", () => {
    const base = inputs("POD_SATURATED", "failed");
    const { items } = planTranscript(
      {
        ...base,
        messages: [
          { role: "user", text: "first", clientMessageId: "c0" },
          { role: "user", text: "second", clientMessageId: "c1" },
        ],
        sendStates: { c0: "failed" },
      },
      calmPolicy(),
    );
    expect(errorItems(items)).toHaveLength(1);
    const users = items.filter((i): i is UserMessageItem => i.kind === "user");
    expect(users.map((u) => u.failureLine)).toEqual([undefined, undefined]);
    expect(users[0]?.retry).toBe(true);
  });

  it("debug keeps the separate notice with its raw code line (the builder's diagnostic)", () => {
    const { items } = planTranscript(inputs("POD_SATURATED", "failed"), debugPolicy());
    const errors = errorItems(items);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ verbatim: "POD_SATURATED: pod envelope text" });
    expect(userItem(items)).toMatchObject({ state: "failed", retry: true });
    expect(userItem(items).failureLine).toBeUndefined();
  });

  it("retryAffordance off still means no Retry, whatever the code", () => {
    const { items } = planTranscript(
      inputs("POD_SATURATED", "failed"),
      calmPolicy({ userMessage: { retryAffordance: false } }),
    );
    expect(userItem(items).retry).toBe(false);
  });
});
