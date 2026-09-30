/**
 * guuey#2031 — the tap ledger: one entry per card tap, begun in the task that
 * receives the relayed `tools/call`, joined to the doorbell by `actionId`, and
 * closed exactly one way — its sent row commits, or it is withdrawn (the
 * runtime will not ring, the relay failed, no doorbell came, the sink refused,
 * or the send never produced its row). Headless: no React, fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpToolCallResult, UiActionRequest } from "@guuey/mcp-apps-host";
import { createTapLedger, TAP_DOORBELL_GRACE_MS, TAP_SENT_GRACE_MS, type TapWithdrawReason } from "./tap-ledger.js";

const SESSION = "render_00000000-0000-4000-8000-000000002031";

function tapRequest(actionId: string, replyId = "hours"): UiActionRequest {
  return {
    resourceUri: `ui://ggui/render/${SESSION}/h`,
    name: "ggui_runtime_submit_action",
    arguments: {
      kind: "dispatch",
      payload: { intent: "chooseReply", actionData: { id: replyId }, uiContext: {} },
      sessionId: SESSION,
      appId: "gapp_synthetic",
      actionId,
      firedAt: "2026-09-30T00:00:00.000Z",
    },
  };
}

function doorbell(actionId: string | null, sessionId = SESSION): { [key: string]: unknown } {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: '<ggui_directive kind="user-action">…</ggui_directive>',
        ...(actionId === null
          ? {}
          : { _meta: { "ai.ggui/userAction": { kind: "user-action", sessionId, actionId, description: "", submittedAt: "", intent: "chooseReply", nextStep: { tool: "ggui_consume", args: { sessionId } } } } }),
      },
    ],
  };
}

const ENQUEUED: McpToolCallResult = { content: [], structuredContent: { ok: true, consumerPresent: false } };
const CONSUMED: McpToolCallResult = { content: [], structuredContent: { ok: true, consumerPresent: true } };
const REFUSED: McpToolCallResult = { content: [], structuredContent: { ok: false, code: "PIPE_NOT_FOUND" } };

function setup(labels: Record<string, string | null> = { hours: "Opening hours", events: "Author events" }) {
  let n = 0;
  const withdrawn: TapWithdrawReason[] = [];
  const onChange = vi.fn();
  const ledger = createTapLedger({
    newId: () => `tap-${++n}`,
    resolveLabel: (request) => {
      const data = request.arguments?.["payload"];
      const id = typeof data === "object" && data !== null && !Array.isArray(data) ? Reflect.get(data, "actionData") : undefined;
      const reply = typeof id === "object" && id !== null ? Reflect.get(id, "id") : undefined;
      return typeof reply === "string" ? (labels[reply] ?? null) : null;
    },
    onChange,
    onWithdraw: (reason) => withdrawn.push(reason),
  });
  return { ledger, withdrawn, onChange };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a tap's pending row: begun at once, swapped for its sent row in one plan", () => {
  it("begin → relay → claim → send: the entry stays pending until a committed message carries its id", async () => {
    const { ledger, onChange } = setup();
    let answer: (r: McpToolCallResult) => void = () => {};
    const relay = vi.fn((_request: UiActionRequest) => new Promise<McpToolCallResult>((resolve) => (answer = resolve)));
    const pending = ledger.wrapCallTool(relay)(tapRequest("a1"));
    // In the same task as the relay call: the entry exists and has its words.
    expect(relay).toHaveBeenCalledTimes(1);
    expect(ledger.pendingTaps()).toEqual([{ id: "tap-1", labels: ["Opening hours"] }]);
    expect(onChange).toHaveBeenCalled();
    answer(ENQUEUED);
    expect(await pending).toBe(ENQUEUED); // the relay's answer, untouched
    expect(ledger.pendingTaps()).toHaveLength(1);

    const claimed = ledger.claimDoorbell(doorbell("a1"));
    expect(claimed).toEqual({ id: "tap-1", labels: ["Opening hours"] });
    const before: { clientMessageId?: string }[] = [{ clientMessageId: "cm-hi" }];
    expect(ledger.markSent(["tap-1"], before)).toEqual({ id: "tap-1", labels: ["Opening hours"] });
    // The send has not committed: same messages array, the entry stays drawn.
    ledger.reconcile(before);
    expect(ledger.pendingTaps()).toEqual([{ id: "tap-1", labels: ["Opening hours"] }]);
    // The commit that carries the row: the entry leaves (the planner already hid it in that plan).
    ledger.reconcile([...before, { clientMessageId: "tap-1" }]);
    expect(ledger.pendingTaps()).toEqual([]);
  });

  it("a tap with no words begins as [null]: the continuation copy is instant too", () => {
    const { ledger } = setup();
    void ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1", "book-now"));
    expect(ledger.pendingTaps()).toEqual([{ id: "tap-1", labels: [null] }]);
  });

  it("a call that is not a tap passes through untouched and begins nothing", async () => {
    const { ledger } = setup();
    const pull: UiActionRequest = { resourceUri: "ui://x", name: "ggui_runtime_pull", arguments: { sessionId: SESSION } };
    const result = await ledger.wrapCallTool(async () => ENQUEUED)(pull);
    expect(result).toBe(ENQUEUED);
    expect(ledger.pendingTaps()).toEqual([]);
  });
});

describe("every other way an entry closes: withdrawn, with a counts-only reason", () => {
  it("the runtime will not ring (not enqueued), or a live consume drained it: withdrawn at the relay's answer", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => REFUSED)(tapRequest("a1"));
    await ledger.wrapCallTool(async () => CONSUMED)(tapRequest("a2"));
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["not-enqueued", "consumed-live"]);
  });

  it("a relay that rejects: withdrawn, and the rejection still reaches the host (never swallowed)", async () => {
    const { ledger, withdrawn } = setup();
    const boom = new Error("relay down");
    await expect(ledger.wrapCallTool(async () => Promise.reject(boom))(tapRequest("a1"))).rejects.toBe(boom);
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["relay-failed"]);
  });

  it("enqueued, but no doorbell within the grace: withdrawn", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    vi.advanceTimersByTime(TAP_DOORBELL_GRACE_MS - 1);
    expect(ledger.pendingTaps()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["no-doorbell"]);
  });

  it("the sink refuses (chat unavailable): the host withdraws the claimed entry", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    const claimed = ledger.claimDoorbell(doorbell("a1"));
    if (claimed === null) throw new Error("claim expected");
    ledger.withdraw(claimed.id, "refused");
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["refused"]);
    // A claimed entry no longer waits on the doorbell grace.
    vi.advanceTimersByTime(TAP_DOORBELL_GRACE_MS * 2);
    expect(withdrawn).toEqual(["refused"]);
  });

  it("a refused send (the messages never change): withdrawn at the sent grace", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    ledger.claimDoorbell(doorbell("a1"));
    const messages: { clientMessageId?: string }[] = [];
    ledger.markSent(["tap-1"], messages);
    ledger.reconcile(messages);
    vi.advanceTimersByTime(TAP_SENT_GRACE_MS);
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["not-sent"]);
  });

  it("an agent client that ignores the send options (its row lands under its own id): withdrawn at that commit", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    ledger.claimDoorbell(doorbell("a1"));
    const before: { clientMessageId?: string }[] = [];
    ledger.markSent(["tap-1"], before);
    ledger.reconcile([{ clientMessageId: "its-own-id" }]);
    expect(ledger.pendingTaps()).toEqual([]);
    expect(withdrawn).toEqual(["not-sent"]);
  });
});

describe("the doorbell join", () => {
  it("two taps while a turn is live merge into ONE send: the first tap's id, both taps' words in order", async () => {
    const { ledger } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1", "hours"));
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a2", "events"));
    const first = ledger.claimDoorbell(doorbell("a1"));
    const second = ledger.claimDoorbell(doorbell("a2"));
    expect([first?.id, second?.id]).toEqual(["tap-1", "tap-2"]);
    // Both still drawn while queued.
    expect(ledger.pendingTaps()).toEqual([
      { id: "tap-1", labels: ["Opening hours"] },
      { id: "tap-2", labels: ["Author events"] },
    ]);
    const merged = ledger.markSent(["tap-1", "tap-2"], []);
    expect(merged).toEqual({ id: "tap-1", labels: ["Opening hours", "Author events"] });
    expect(ledger.pendingTaps()).toEqual([{ id: "tap-1", labels: ["Opening hours", "Author events"] }]);
  });

  it("a doorbell with no actionId in its meta claims nothing (no join is guessed); the entry closes by its grace", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    expect(ledger.claimDoorbell(doorbell(null))).toBeNull();
    expect(ledger.pendingTaps()).toHaveLength(1);
    vi.advanceTimersByTime(TAP_DOORBELL_GRACE_MS);
    expect(withdrawn).toEqual(["no-doorbell"]);
  });

  it("a doorbell naming another session, or an action already claimed, claims nothing", async () => {
    const { ledger } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    expect(ledger.claimDoorbell(doorbell("a1", "render_other"))).toBeNull();
    expect(ledger.claimDoorbell(doorbell("a1"))).not.toBeNull();
    expect(ledger.claimDoorbell(doorbell("a1"))).toBeNull();
  });

  it("the host-bound session reaches the label resolver", () => {
    const seen: (string | undefined)[] = [];
    const ledger = createTapLedger({
      newId: () => "tap-1",
      resolveLabel: (_request, boundSessionId) => {
        seen.push(boundSessionId);
        return null;
      },
      onChange: () => {},
    });
    void ledger.wrapCallTool(async () => ENQUEUED, { boundSessionId: SESSION })(tapRequest("a1"));
    void ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a2"));
    expect(seen).toEqual([SESSION, undefined]);
  });
});

describe("reset and dispose", () => {
  it("reset drops every entry and every timer (a cleared conversation holds nothing)", async () => {
    const { ledger, withdrawn } = setup();
    await ledger.wrapCallTool(async () => ENQUEUED)(tapRequest("a1"));
    ledger.reset();
    expect(ledger.pendingTaps()).toEqual([]);
    vi.advanceTimersByTime(TAP_DOORBELL_GRACE_MS * 2);
    expect(withdrawn).toEqual([]);
  });

  it("a relay answer for an entry that is gone changes nothing", async () => {
    const { ledger, withdrawn } = setup();
    let answer: (r: McpToolCallResult) => void = () => {};
    const pending = ledger.wrapCallTool(() => new Promise<McpToolCallResult>((resolve) => (answer = resolve)))(tapRequest("a1"));
    ledger.reset();
    answer(REFUSED);
    await pending;
    expect(withdrawn).toEqual([]);
    expect(ledger.pendingTaps()).toEqual([]);
  });
});
