/**
 * The §3 transition table, pinned rule by rule — including the ggui#633
 * calibration additions (streaming-gated view close, the founder-(d)
 * pending window).
 */
import { describe, expect, it } from "vitest";
import {
  agentModeReduce,
  INITIAL_AGENT_MODE_STATE,
  type AgentModeInput,
  type AgentModeState,
} from "./machine.js";

function run(...inputs: AgentModeInput["type"][]): AgentModeState {
  return inputs.reduce(
    (s, type) => agentModeReduce(s, { type }),
    INITIAL_AGENT_MODE_STATE,
  );
}

describe("active-panel machine (§3)", () => {
  it("opens as the app; the agent earns the room by being addressed", () => {
    expect(INITIAL_AGENT_MODE_STATE.activePanel).toBe("app");
    expect(run("agentSubmit").activePanel).toBe("agent");
  });

  it("submit flips ON SUBMIT and arms streaming + the (d) pending window", () => {
    const s = run("agentSubmit");
    expect(s).toEqual({ activePanel: "agent", streaming: true, pending: true });
  });

  it("stream end changes NOTHING about the panel (no bounce-back), but closes streaming and pending", () => {
    const s = run("agentSubmit", "agentSettled");
    expect(s.activePanel).toBe("agent");
    expect(s.streaming).toBe(false);
    // The answer is in the log even when no view came — working state ends.
    expect(s.pending).toBe(false);
  });

  it("mid-stream menu click re-follows the user WITHOUT touching the stream", () => {
    const s = run("agentSubmit", "menuInteraction");
    expect(s.activePanel).toBe("app");
    expect(s.streaming).toBe(true); // transport owns the stream
    expect(s.pending).toBe(false); // return-to-menu clears the (d) window
  });

  it("a live view mount clears the (d) window and nothing else", () => {
    const s = run("agentSubmit", "agentViewMounted");
    expect(s).toEqual({ activePanel: "agent", streaming: true, pending: false });
  });

  it("closing an agent view returns to the menu UNLESS still streaming", () => {
    expect(run("agentSubmit", "agentViewMounted", "agentViewClosed").activePanel).toBe("agent");
    expect(
      run("agentSubmit", "agentViewMounted", "agentSettled", "agentViewClosed").activePanel,
    ).toBe("app");
  });

  it("rapid alternation: last input wins, no queue", () => {
    const s = run("agentSubmit", "menuInteraction", "agentSubmit", "menuInteraction");
    expect(s.activePanel).toBe("app");
  });
});

describe("guuey#427 — the neutral panel activation", () => {
  it("agentPanelActivated flips the panel and NOTHING else — no working state, no streaming", () => {
    const s = run("agentPanelActivated");
    expect(s).toEqual({ activePanel: "agent", streaming: false, pending: false });
  });

  it("reopening the agent panel after a settled turn never re-arms the spinner (the first consumer's near-miss)", () => {
    const s = run("agentSubmit", "agentViewMounted", "agentSettled", "menuInteraction", "agentPanelActivated");
    expect(s.activePanel).toBe("agent");
    expect(s.pending).toBe(false);
    expect(s.streaming).toBe(false);
  });
});
