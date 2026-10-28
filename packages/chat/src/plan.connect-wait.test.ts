/**
 * guuey#2453 — ONE connect ladder. While a turn is `connecting`, the wait the
 * transport reports picks the line: a busy pod draws the busy line (unchanged),
 * a waking app draws the waking line at once (no guess) and swaps once to the
 * long line at `policy.status.longStartMs`, and no wait keeps the elapsed
 * ladder exactly as before. `planStatusLine` is the one function, exported so a
 * host header reads the same line the transcript draws.
 */
import { describe, expect, it } from "vitest";
import { planStatusLine, planTranscript, type StatusInputs } from "./plan.js";
import { calmPolicy, debugPolicy } from "./policy.js";
import { defaultChatStrings } from "./strings.js";
import type { ConnectWait, TranscriptInputs } from "./types.js";

const policy = calmPolicy();
const { wakingMs, longStartMs } = policy.status;

function inputs(connectWait: ConnectWait | null | undefined, statusElapsedMs = 0, status: TranscriptInputs["status"] = "connecting"): TranscriptInputs {
  return {
    result: null,
    assistantText: "",
    status,
    statusElapsedMs,
    activeTool: null,
    error: null,
    prompts: [],
    messages: [],
    ...(connectWait !== undefined ? { connectWait } : {}),
  };
}

const WAKING: ConnectWait = { kind: "waking" };

describe("the waking line (guuey#2453)", () => {
  it("the kit's words", () => {
    expect(defaultChatStrings.waking).toBe("Waking up…");
    expect(defaultChatStrings.wakingLong).toBe("Still waking up…");
  });

  it("a waking wait draws the waking line at 0 ms: the signal, never a guess", () => {
    expect(planTranscript(inputs(WAKING, 0), policy).status).toEqual({
      kind: "status",
      key: "status",
      state: "waking",
      copy: "Waking up…",
      detail: null,
    });
  });

  it("holds the short line past the ladder's starting step, and swaps once at longStartMs", () => {
    expect(planTranscript(inputs(WAKING, wakingMs), policy).status?.copy).toBe(defaultChatStrings.waking);
    expect(planTranscript(inputs(WAKING, longStartMs - 1), policy).status?.copy).toBe(defaultChatStrings.waking);
    const long = planTranscript(inputs(WAKING, longStartMs), policy).status;
    expect(long?.state).toBe("waking");
    expect(long?.copy).toBe(defaultChatStrings.wakingLong);
    expect(planTranscript(inputs(WAKING, 120_000), policy).status?.copy).toBe(defaultChatStrings.wakingLong);
  });

  it("the swap follows the policy's one long threshold", () => {
    const quick = calmPolicy({ status: { wakingMs: 2500, longStartMs: 4_000 } });
    expect(planTranscript(inputs(WAKING, 3_999), quick).status?.copy).toBe(defaultChatStrings.waking);
    expect(planTranscript(inputs(WAKING, 4_000), quick).status?.copy).toBe(defaultChatStrings.wakingLong);
  });

  it("a builder's strings win", () => {
    const own = calmPolicy({ strings: { waking: "Aufwachen…", wakingLong: "Dauert noch." } });
    expect(planTranscript(inputs(WAKING, 0), own).status?.copy).toBe("Aufwachen…");
    expect(planTranscript(inputs(WAKING, longStartMs), own).status?.copy).toBe("Dauert noch.");
  });

  it("is a connecting-phase line only", () => {
    expect(planTranscript(inputs(WAKING, 0, "thinking"), policy).status?.state).toBe("thinking");
    expect(planTranscript(inputs(WAKING, 0, "ready"), policy).status).toBeNull();
  });

  it("debug keeps its literal detail", () => {
    expect(planTranscript(inputs(WAKING, 40), debugPolicy()).status?.detail).toBe("connecting · 40 ms");
  });
});

describe("the busy arm and the ladder are unchanged (guuey#2453)", () => {
  it("busy: the countdown line and its announce, byte for byte", () => {
    const status = planTranscript(inputs({ kind: "busy", attempt: 2, totalAttempts: 4, secondsLeft: 9 }, 40_000), policy).status;
    expect(status).toEqual({
      kind: "status",
      key: "status",
      state: "busy",
      copy: defaultChatStrings.saturationRetrying(2, 4, 9),
      announce: defaultChatStrings.saturationRetrying(2, 4),
      detail: null,
    });
    expect(status?.copy).toBe("Busy right now. Retrying in 9s (2/4)…");
  });

  it("no wait (absent or null): today's elapsed ladder, byte for byte", () => {
    for (const wait of [undefined, null]) {
      const at = (ms: number) => planTranscript(inputs(wait, ms), policy).status;
      expect(at(0)).toEqual({ kind: "status", key: "status", state: "connecting", copy: "Connecting…", detail: null });
      expect(at(wakingMs - 1)?.state).toBe("connecting");
      expect(at(wakingMs)).toEqual({ kind: "status", key: "status", state: "starting", copy: "Getting ready…", detail: null });
      expect(at(longStartMs)).toEqual({
        kind: "status",
        key: "status",
        state: "long-start",
        copy: "Still getting ready…",
        detail: null,
      });
    }
  });
});

describe("planStatusLine (guuey#2453)", () => {
  it("is the line planTranscript draws, read from the status fields alone", () => {
    const cases: StatusInputs[] = [
      { status: "connecting", statusElapsedMs: 0, activeTool: null, connectWait: WAKING },
      { status: "connecting", statusElapsedMs: longStartMs, activeTool: null, connectWait: WAKING },
      { status: "connecting", statusElapsedMs: 0, activeTool: null, connectWait: { kind: "busy", attempt: 1, totalAttempts: 3 } },
      { status: "connecting", statusElapsedMs: wakingMs, activeTool: null },
      { status: "thinking", statusElapsedMs: 0, activeTool: null },
      { status: "using-tool", statusElapsedMs: 0, activeTool: "search_flights" },
      { status: "connecting", statusElapsedMs: 0, activeTool: null, aborted: true },
      { status: "responding", statusElapsedMs: 0, activeTool: null },
    ];
    for (const c of cases) {
      expect(planStatusLine(c, policy)).toEqual(planTranscript({ ...inputs(undefined), ...c }, policy).status);
    }
  });
});
