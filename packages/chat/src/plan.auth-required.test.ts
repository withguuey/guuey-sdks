/**
 * guuey#605 — `plan.authRequired`, the transcript-level typed refusal.
 *
 * An `authMode:'upfront'` OAuth server the end user has not connected makes
 * the RUNTIME refuse every turn before any model call, and card the sign-in
 * as the turn's only content. This is the plan's read of that: which servers
 * a surface must show the connect step for, and therefore when it holds its
 * composer. It is derived from PENDING asks only — the client is not the
 * enforcer, so a settled or dismissed record must never brick the chat.
 */
import { describe, expect, it } from "vitest";
import type { AgPausedAsk } from "@silverprotocol/core";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { HitlPromptItem, TranscriptInputs } from "./types.js";

const START = "https://mcp.dev.sandbox.guuey.com/oauth/start?state=" + "a".repeat(64);

function ask(overrides: Partial<AgPausedAsk> = {}): AgPausedAsk {
  return {
    askId: "mcp-oauth:app_1:linear:t1",
    kind: "auth",
    message: "Trip Planner wants to use your Linear account",
    authConfig: { scheme: "oauth2", authorizationUrl: START },
    grantModes: [{ id: "always", label: "Always allow" }],
    metadata: { appId: "app_1", serverName: "linear", displayName: "Linear", authMode: "upfront" },
    ...overrides,
  };
}

function inputs(
  prompts: TranscriptInputs["prompts"],
  assistantText = "",
): TranscriptInputs {
  return {
    result: null,
    assistantText,
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts,
    messages: [],
  };
}

function hitlItem(plan: ReturnType<typeof planTranscript>): HitlPromptItem {
  const item = plan.items.find((i) => i.kind === "prompt" && i.promptKind === "hitl");
  if (item === undefined || item.kind !== "prompt" || item.promptKind !== "hitl") {
    throw new Error("no hitl prompt planned");
  }
  return item;
}

describe("plan.authRequired (guuey#605)", () => {
  it("names the pending upfront servers — the connect step a surface must show first", () => {
    const plan = planTranscript(
      inputs([{ id: "a1", kind: "hitl", ask: ask(), state: "pending" }]),
      calmPolicy(),
    );
    expect(plan.authRequired).toEqual({
      servers: [{ serverName: "linear", label: "Linear", ask: ask() }],
    });
  });

  it("is null for an ON-DEMAND ask — today's consent card never gates the composer", () => {
    const onDemand = ask({ metadata: { appId: "app_1", serverName: "linear" } });
    const plan = planTranscript(
      inputs([{ id: "a1", kind: "hitl", ask: onDemand, state: "pending" }]),
      calmPolicy(),
    );
    expect(plan.authRequired).toBeNull();
    // ...and the card itself is not framed as a required step.
    expect(hitlItem(plan).oauth).toEqual({ authorizationUrl: START, scopes: [], upfront: false });
  });

  it("RELEASES on a dismissal or an answer — a 'no' must not dead-end a user who cannot un-dismiss", () => {
    for (const state of ["cancelled", "declined", "resolved"] as const) {
      const plan = planTranscript(
        inputs([{ id: "a1", kind: "hitl", ask: ask(), state }]),
        calmPolicy(),
      );
      expect(plan.authRequired).toBeNull();
    }
  });

  it("marks the card itself as a required connection, so it reads as a step and not an aside", () => {
    const plan = planTranscript(
      inputs([{ id: "a1", kind: "hitl", ask: ask(), state: "pending" }]),
      calmPolicy(),
    );
    expect(hitlItem(plan).oauth).toEqual({ authorizationUrl: START, scopes: [], upfront: true });
  });

  it("a plan with no prompts at all carries null — every ordinary transcript is untouched", () => {
    expect(planTranscript(inputs([], "Hello."), calmPolicy()).authRequired).toBeNull();
  });

  it("gathers several pending upfront servers into one gate", () => {
    const notion = ask({
      askId: "mcp-oauth:app_1:notion:t1",
      metadata: { appId: "app_1", serverName: "notion", displayName: "Notion", authMode: "upfront" },
    });
    const plan = planTranscript(
      inputs([
        { id: "a1", kind: "hitl", ask: ask(), state: "pending" },
        { id: "a2", kind: "hitl", ask: notion, state: "pending" },
      ]),
      calmPolicy(),
    );
    expect(plan.authRequired?.servers.map((s) => s.label)).toEqual(["Linear", "Notion"]);
  });
});
