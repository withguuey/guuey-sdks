/**
 * guuey#356 — the lifted staging policy. Coverage ported from the widget's
 * widget-view-staging suite (the #198/#215/#218 pins), re-shaped onto the
 * composable `withActionStaging` wrapper.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ACTION_STAGED_MSG,
  isStageableAction,
  stagedActionText,
  withActionStaging,
} from "./action-staging.js";
import { unavailableToolCallResult, type McpToolCallResult } from "./action.js";

const RELAYED: McpToolCallResult = { content: [{ type: "text", text: "relayed" }] };

describe("stagedActionText — the projection", () => {
  it("humanizes the action name and flattens primitive arguments", () => {
    expect(stagedActionText("book_slot", { day: "tuesday", time: "3pm" })).toBe(
      "Book slot: day tuesday, time 3pm",
    );
    expect(stagedActionText("selectSlot", undefined)).toBe("Select slot");
  });

  it("refuses shapes with no honest text form (nothing partial, nothing misleading)", () => {
    expect(stagedActionText("book_slot", { nested: { deep: true } })).toBeNull();
    expect(stagedActionText("book_slot", ["array"])).toBeNull();
  });

  it("guuey#215: unwraps the semantic envelope — the actionId is the action, never the carrier", () => {
    expect(
      stagedActionText("ggui_runtime_submit_action", { actionId: "book_slot", day: "tuesday" }),
    ).toBe("Book slot: day tuesday");
    // No string actionId ⇒ no honest projection.
    expect(stagedActionText("ggui_runtime_submit_action", { day: "tuesday" })).toBeNull();
    expect(stagedActionText("ggui_runtime_submit_action", "raw")).toBeNull();
  });
});

describe("isStageableAction — the guuey#218 allowlist gate", () => {
  it("admits the semantic carrier and refuses plumbing/unlisted names alike", () => {
    expect(isStageableAction("ggui_runtime_submit_action")).toBe(true);
    expect(isStageableAction("ggui_runtime_pull")).toBe(false);
    expect(isStageableAction("refresh_ws_token")).toBe(false);
    expect(isStageableAction("book_slot")).toBe(false);
  });
});

describe("withActionStaging — the composable seam (guuey#356)", () => {
  const request = (name: string, args?: Record<string, unknown>) => ({
    resourceUri: "ui://x/1",
    name,
    ...(args !== undefined ? { arguments: args } : {}),
  });

  it("post-turn: stages the projection, answers the STAGED notice (not isError), never touches inner", async () => {
    const inner = vi.fn(async () => RELAYED);
    const stage = vi.fn();
    const wrapped = withActionStaging(inner, { isTurnLive: () => false, stage });
    const result = await wrapped(
      request("ggui_runtime_submit_action", { actionId: "book_slot", day: "tuesday" }),
    );
    expect(stage).toHaveBeenCalledWith("Book slot: day tuesday");
    expect(result).toEqual({ content: [{ type: "text", text: ACTION_STAGED_MSG }] });
    expect(result.isError).toBeUndefined();
    expect(inner).not.toHaveBeenCalled();
  });

  it("mid-turn: the relay path is byte-identical — staging never fires", async () => {
    const inner = vi.fn(async () => RELAYED);
    const stage = vi.fn();
    const wrapped = withActionStaging(inner, { isTurnLive: () => true, stage });
    await expect(
      wrapped(request("ggui_runtime_submit_action", { actionId: "book_slot" })),
    ).resolves.toBe(RELAYED);
    expect(stage).not.toHaveBeenCalled();
  });

  it("guuey#215/#218: internal rungs and foreign plumbing NEVER stage post-turn", async () => {
    const inner = vi.fn(async () => RELAYED);
    const stage = vi.fn();
    const wrapped = withActionStaging(inner, { isTurnLive: () => false, stage });
    await expect(wrapped(request("ggui_runtime_pull", { sessionId: "s" }))).resolves.toBe(RELAYED);
    await expect(wrapped(request("acme_sync", { token: "t" }))).resolves.toBe(RELAYED);
    expect(stage).not.toHaveBeenCalled();
  });

  it("a projection-less semantic call falls through to inner — truthful degradation over a misleading stage", async () => {
    const inner = vi.fn(async () => unavailableToolCallResult());
    const stage = vi.fn();
    const wrapped = withActionStaging(inner, { isTurnLive: () => false, stage });
    const result = await wrapped(
      request("ggui_runtime_submit_action", { actionId: "book", payload: { nested: true } }),
    );
    expect(stage).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("staging absent: returns inner unchanged (identity — composes freely)", () => {
    const inner = async (): Promise<McpToolCallResult> => RELAYED;
    expect(withActionStaging(inner, undefined)).toBe(inner);
  });
});
