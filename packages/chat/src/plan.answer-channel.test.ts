/**
 * guuey#1860 L1 — an ask is offered as a control only when something in this
 * chat can answer it. The pod's answer door answers its profile consent; the
 * broker answers its MCP OAuth consent by its authorization URL; an agent
 * framework's own ask (an ADK tool approval, an ADK credential request, a
 * request for input) has neither yet, so it plans as information.
 */
import { describe, expect, it } from "vitest";
import type { AgPausedAsk } from "@silverprotocol/core";
import { hitlAnswerChannel } from "./hitl.js";
import { planTranscript } from "./plan.js";
import { calmPolicy } from "./policy.js";
import type { HitlPromptItem, TranscriptInputs } from "./types.js";

const START = "https://mcp.dev.sandbox.guuey.com/oauth/start?state=" + "a".repeat(64);

/** An ADK-relayed ask carries the framework's function-call id, never a guuey prefix. */
const ADK_APPROVAL: AgPausedAsk = {
  askId: "adk-fc-9f2c",
  kind: "approval",
  message: "Approve booking the flight?",
  metadata: { originalFunctionCallId: "adk-fc-1a7e" },
};
const ADK_CREDENTIAL: AgPausedAsk = {
  askId: "adk-fc-77b1",
  kind: "auth",
  message: "Sign in to Google Calendar",
  authConfig: { scheme: "oauth2", authorizationUrl: "https://accounts.example.com/o/oauth2/auth?client_id=x" },
};
const ADK_INPUT: AgPausedAsk = { askId: "adk-fc-3c00", kind: "text", message: "Which city?" };
const CONSENT: AgPausedAsk = {
  askId: "profile-consent:app-1:thread-1",
  kind: "approval",
  message: "Share your profile?",
  grantModes: [{ id: "always", label: "Always" }],
};
const MCP_OAUTH: AgPausedAsk = {
  askId: "mcp-oauth:app_1:linear:t1",
  kind: "auth",
  message: "Trip Planner wants to use your Linear account",
  authConfig: { scheme: "oauth2", authorizationUrl: START },
  grantModes: [{ id: "always", label: "Always allow" }],
  metadata: { appId: "app_1", serverName: "linear", displayName: "Linear", authMode: "upfront" },
};

function plan(ask: AgPausedAsk) {
  const inputs: TranscriptInputs = {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [{ id: ask.askId, kind: "hitl", ask, state: "pending" }],
    messages: [],
  };
  return planTranscript(inputs, calmPolicy());
}

function hitlItem(p: ReturnType<typeof planTranscript>): HitlPromptItem {
  const item = p.items.find((i) => i.kind === "prompt" && i.promptKind === "hitl");
  if (item === undefined || item.kind !== "prompt" || item.promptKind !== "hitl") throw new Error("no hitl prompt planned");
  return item;
}

describe("hitlAnswerChannel (guuey#1860)", () => {
  it("the door answers profile consent, the broker answers MCP OAuth, nothing answers the rest", () => {
    expect(hitlAnswerChannel(CONSENT)).toBe("door");
    expect(hitlAnswerChannel(MCP_OAUTH)).toBe("broker");
    for (const ask of [ADK_APPROVAL, ADK_CREDENTIAL, ADK_INPUT]) expect(hitlAnswerChannel(ask), ask.askId).toBe("none");
  });

  it("matches a prefix, never a substring", () => {
    expect(hitlAnswerChannel({ askId: "x-profile-consent:app-1" })).toBe("none");
    expect(hitlAnswerChannel({ askId: "x-mcp-oauth:app_1:linear" })).toBe("none");
  });
});

describe("planTranscript stamps how each ask is answered (guuey#1860)", () => {
  it("an ADK credential ask plans as information: no OAuth arm, and it never holds the composer", () => {
    const p = plan(ADK_CREDENTIAL);
    expect(hitlItem(p)).toMatchObject({ answer: "none", oauth: null });
    expect(p.authRequired).toBeNull();
  });

  it("a framework ask carrying the broker's connect-first metadata still never holds the composer", () => {
    // Only the broker's own asks may hold the chat; metadata alone does not make
    // an ask the broker's (the askId prefix does).
    const p = plan({ ...ADK_CREDENTIAL, metadata: { serverName: "calendar", authMode: "upfront" } });
    expect(hitlItem(p).answer).toBe("none");
    expect(p.authRequired).toBeNull();
  });

  it("an ADK approval and an ADK input request plan as information", () => {
    expect(hitlItem(plan(ADK_APPROVAL)).answer).toBe("none");
    expect(hitlItem(plan(ADK_INPUT)).answer).toBe("none");
  });

  it("the broker's own ask keeps its OAuth arm and its connect-first hold", () => {
    const p = plan(MCP_OAUTH);
    expect(hitlItem(p)).toMatchObject({ answer: "broker", oauth: { authorizationUrl: START, upfront: true } });
    expect(p.authRequired?.servers.map((s) => s.serverName)).toEqual(["linear"]);
  });

  it("the door's consent ask is answerable", () => {
    expect(hitlItem(plan(CONSENT))).toMatchObject({ answer: "door", oauth: null });
  });
});
