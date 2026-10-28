/**
 * guuey#2604 — the busy status line. While the transport waits to resend a
 * turn the agent refused at its concurrent-turn ceiling, the plan says so
 * (`state: "busy"`) instead of letting the connecting ladder climb to "Still
 * getting ready…" over the wait.
 */
import { describe, expect, it } from "vitest";
import { planTranscript } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import type { SaturationWait, TranscriptInputs } from "./types.js";

function inputs(
  status: TranscriptInputs["status"],
  saturationWait: SaturationWait | null | undefined,
  statusElapsedMs = 0,
): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status,
    statusElapsedMs,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [],
    ...(saturationWait !== undefined ? { saturationWait } : {}),
  };
}

describe("the busy status line (guuey#2604)", () => {
  it("connecting + a saturation wait plans the busy line with the retry count", () => {
    const status = planTranscript(inputs("connecting", { attempt: 1, totalAttempts: 4 }), calmPolicy()).status;
    expect(status).toEqual({
      kind: "status",
      key: "status",
      state: "busy",
      copy: "Busy right now. Retrying (1/4)…",
      detail: null,
    });
  });

  it("wins over the connecting ladder however long the wait has run", () => {
    const status = planTranscript(inputs("connecting", { attempt: 3, totalAttempts: 4 }, 40_000), calmPolicy()).status;
    expect(status?.state).toBe("busy");
    expect(status?.copy).toBe("Busy right now. Retrying (3/4)…");
  });

  it("no wait (absent or null) keeps the connecting ladder exactly as before", () => {
    expect(planTranscript(inputs("connecting", undefined), calmPolicy()).status?.state).toBe("connecting");
    expect(planTranscript(inputs("connecting", null, 20_000), calmPolicy()).status?.state).toBe("long-start");
  });

  it("is a connecting-phase line only: once the turn moves on, a stale wait shows nothing", () => {
    const wait = { attempt: 1, totalAttempts: 4 };
    expect(planTranscript(inputs("thinking", wait), calmPolicy()).status?.state).toBe("thinking");
    expect(planTranscript(inputs("ready", wait), calmPolicy()).status).toBeNull();
  });

  it("a builder's strings.saturationRetrying wins", () => {
    const policy = calmPolicy({
      strings: { ...calmPolicy().strings, saturationRetrying: (n, total) => `Attente ${n} sur ${total}` },
    });
    expect(planTranscript(inputs("connecting", { attempt: 2, totalAttempts: 4 }), policy).status?.copy).toBe(
      "Attente 2 sur 4",
    );
  });

  it("the debug preset keeps its detail facet", () => {
    const status = planTranscript(inputs("connecting", { attempt: 1, totalAttempts: 4 }, 1200), debugPolicy()).status;
    expect(status?.detail).toBe("connecting · 1200 ms");
  });

  it("guuey#2608: a renderer's countdown names the seconds to the next try", () => {
    const status = planTranscript(
      inputs("connecting", { attempt: 1, totalAttempts: 4, secondsLeft: 12 }),
      calmPolicy(),
    ).status;
    expect(status?.state).toBe("busy");
    expect(status?.copy).toBe("Busy right now. Retrying in 12s (1/4)…");
  });

  it("guuey#2608: at 0 the try is under way, and the line names no time", () => {
    const status = planTranscript(inputs("connecting", { attempt: 2, totalAttempts: 4, secondsLeft: 0 }), calmPolicy()).status;
    expect(status?.copy).toBe("Busy right now. Retrying (2/4)…");
  });

  it("guuey#2608: a builder's two-argument string keeps working beside a countdown", () => {
    const policy = calmPolicy({
      strings: { ...calmPolicy().strings, saturationRetrying: (n, total) => `Attente ${n} sur ${total}` },
    });
    expect(
      planTranscript(inputs("connecting", { attempt: 2, totalAttempts: 4, secondsLeft: 9 }), policy).status?.copy,
    ).toBe("Attente 2 sur 4");
  });

  it("guuey#2608: a ticking countdown carries the attempt-only line to announce", () => {
    const status = planTranscript(
      inputs("connecting", { attempt: 1, totalAttempts: 4, secondsLeft: 12 }),
      calmPolicy(),
    ).status;
    expect(status?.copy).toBe("Busy right now. Retrying in 12s (1/4)…");
    expect(status?.announce).toBe("Busy right now. Retrying (1/4)…");
    const nextTick = planTranscript(
      inputs("connecting", { attempt: 1, totalAttempts: 4, secondsLeft: 11 }),
      calmPolicy(),
    ).status;
    expect(nextTick?.announce).toBe(status?.announce);
  });

  it("guuey#2608: with no countdown the line announces itself (no announce field)", () => {
    expect(planTranscript(inputs("connecting", { attempt: 2, totalAttempts: 4 }), calmPolicy()).status).not.toHaveProperty(
      "announce",
    );
    expect(
      planTranscript(inputs("connecting", { attempt: 2, totalAttempts: 4, secondsLeft: 0 }), calmPolicy()).status,
    ).not.toHaveProperty("announce");
  });

  it("the default copy carries no em dash", () => {
    expect(calmPolicy().strings.saturationRetrying(1, 4, 12)).not.toContain("—");
    expect(calmPolicy().strings.saturationRetrying(1, 4)).not.toContain("—");
    expect(calmPolicy().strings.errorPodSaturated).not.toContain("—");
  });
});
