/**
 * guuey#2031 — `AgentMessage.tapLabels` and `SendOptions.tapLabels` spell out
 * `@guuey/mcp-apps-host`'s `TapLabels` (the transport's import closure carries
 * no `@guuey/mcp-apps-host`). This holds the spellings equal: a drift on either
 * side fails the type check of this file.
 */
import { describe, expect, it } from "vitest";
import type { TapLabels } from "@guuey/mcp-apps-host/narrowing";
import type { AgentMessage, SendOptions } from "./types.js";

/** `true` only when A and B are each assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the tap-label spellings agree", () => {
  it("AgentMessage.tapLabels and SendOptions.tapLabels are TapLabels", () => {
    const onMessage: Same<NonNullable<AgentMessage["tapLabels"]>, TapLabels> = true;
    const onSend: Same<NonNullable<SendOptions["tapLabels"]>, TapLabels> = true;
    expect([onMessage, onSend]).toEqual([true, true]);
  });
});
