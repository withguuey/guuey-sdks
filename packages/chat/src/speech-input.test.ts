/**
 * guuey#2446 — the headless voice-input core: one pure reducer over the
 * session phases, where every action carries the session generation and an
 * event from any other generation changes nothing. Node, no DOM: the root
 * subpath stays React-free and DOM-free.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_SPEECH_INPUT_STATE,
  joinSpeechText,
  speechInputReducer,
  speechSessionLive,
  speechSessionText,
  type SpeechInputAction,
  type SpeechInputState,
  type SpeechRecognizerEvent,
} from "./speech-input.js";

function run(actions: readonly SpeechInputAction[], from: SpeechInputState = INITIAL_SPEECH_INPUT_STATE): SpeechInputState {
  return actions.reduce(speechInputReducer, from);
}

const engine = (generation: number, event: SpeechRecognizerEvent): SpeechInputAction => ({ type: "engine", generation, event });
const result = (generation: number, finalText: string, interim = ""): SpeechInputAction =>
  engine(generation, { type: "result", finalText, interim });

describe("voice: headless core, speechInputReducer (guuey#2446)", () => {
  it("starts idle", () => {
    expect(INITIAL_SPEECH_INPUT_STATE).toEqual({ phase: "idle" });
  });

  it("idle → starting → listening(finalText, interim) → stopping(finalText, interim) → idle", () => {
    let s = run([{ type: "start", generation: 1 }]);
    expect(s).toEqual({ phase: "starting", generation: 1 });
    s = speechInputReducer(s, engine(1, { type: "start" }));
    expect(s).toEqual({ phase: "listening", generation: 1, finalText: "", interim: "" });
    s = speechInputReducer(s, result(1, "hello", "wor"));
    expect(s).toEqual({ phase: "listening", generation: 1, finalText: "hello", interim: "wor" });
    s = speechInputReducer(s, { type: "stop", generation: 1 });
    expect(s).toEqual({ phase: "stopping", generation: 1, finalText: "hello", interim: "wor" });
    s = speechInputReducer(s, engine(1, { type: "end" }));
    expect(s).toEqual({ phase: "idle" });
  });

  it("a result before the engine's own start event still lands (an engine may skip the start event)", () => {
    const s = run([{ type: "start", generation: 1 }, result(1, "hi")]);
    expect(s).toEqual({ phase: "listening", generation: 1, finalText: "hi", interim: "" });
  });

  it("the trailing final: a same-generation result after stop() and before end updates the text in stopping", () => {
    const s = run([
      { type: "start", generation: 1 },
      engine(1, { type: "start" }),
      result(1, "the first sentence", "the sec"),
      { type: "stop", generation: 1 },
      result(1, "the first sentence the second sentence"),
    ]);
    expect(s).toEqual({ phase: "stopping", generation: 1, finalText: "the first sentence the second sentence", interim: "" });
    expect(speechSessionText(s)).toBe("the first sentence the second sentence");
  });

  it("stop() from starting keeps an empty stopping session that ends on the engine's end", () => {
    let s = run([{ type: "start", generation: 1 }, { type: "stop", generation: 1 }]);
    expect(s).toEqual({ phase: "stopping", generation: 1, finalText: "", interim: "" });
    s = speechInputReducer(s, engine(1, { type: "end" }));
    expect(s).toEqual({ phase: "idle" });
  });

  it("abort() drops: a result after abort and before end changes nothing", () => {
    const listening = run([{ type: "start", generation: 1 }, engine(1, { type: "start" }), result(1, "keep")]);
    const aborted = speechInputReducer(listening, { type: "abort", generation: 1 });
    expect(aborted).toEqual({ phase: "idle" });
    expect(speechInputReducer(aborted, result(1, "keep and more"))).toBe(aborted);
    expect(speechInputReducer(aborted, engine(1, { type: "end" }))).toBe(aborted);
  });

  it("abort() also drops a stopping session's pending final", () => {
    const stopping = run([{ type: "start", generation: 1 }, result(1, "a"), { type: "stop", generation: 1 }]);
    const aborted = speechInputReducer(stopping, { type: "abort", generation: 1 });
    expect(aborted).toEqual({ phase: "idle" });
    expect(speechInputReducer(aborted, result(1, "a b"))).toBe(aborted);
  });

  it("start or a second stop while stopping is a no-op", () => {
    const stopping = run([{ type: "start", generation: 1 }, result(1, "a"), { type: "stop", generation: 1 }]);
    expect(speechInputReducer(stopping, { type: "start", generation: 2 })).toBe(stopping);
    expect(speechInputReducer(stopping, { type: "stop", generation: 1 })).toBe(stopping);
  });

  it("start while starting or listening is a no-op", () => {
    const starting = run([{ type: "start", generation: 1 }]);
    expect(speechInputReducer(starting, { type: "start", generation: 2 })).toBe(starting);
    const listening = speechInputReducer(starting, engine(1, { type: "start" }));
    expect(speechInputReducer(listening, { type: "start", generation: 2 })).toBe(listening);
  });

  it("a stale-generation event, stop or abort is ignored", () => {
    const listening = run([{ type: "start", generation: 2 }, engine(2, { type: "start" }), result(2, "now")]);
    expect(speechInputReducer(listening, result(1, "old"))).toBe(listening);
    expect(speechInputReducer(listening, engine(1, { type: "end" }))).toBe(listening);
    expect(speechInputReducer(listening, engine(1, { type: "error", code: "network" }))).toBe(listening);
    expect(speechInputReducer(listening, { type: "stop", generation: 1 })).toBe(listening);
    expect(speechInputReducer(listening, { type: "abort", generation: 1 })).toBe(listening);
  });

  it("a stale session: a previous generation's result arriving after a new start() is ignored, and the new session's text is untouched", () => {
    const s = run([
      { type: "start", generation: 1 },
      result(1, "first session"),
      { type: "stop", generation: 1 },
      engine(1, { type: "end" }),
      { type: "start", generation: 2 },
      result(2, "second"),
      result(1, "first session, a slow final"),
    ]);
    expect(s).toEqual({ phase: "listening", generation: 2, finalText: "second", interim: "" });
  });

  it("no-speech → no-match, then idle when the no-match timer of the same generation expires", () => {
    const noMatch = run([{ type: "start", generation: 3 }, engine(3, { type: "start" }), engine(3, { type: "error", code: "no-speech" })]);
    expect(noMatch).toEqual({ phase: "no-match", generation: 3 });
    // The engine's end after the error leaves the line up.
    expect(speechInputReducer(noMatch, engine(3, { type: "end" }))).toBe(noMatch);
    // A previous no-match's timer does not clear this one.
    expect(speechInputReducer(noMatch, { type: "no-match-expired", generation: 2 })).toBe(noMatch);
    expect(speechInputReducer(noMatch, { type: "no-match-expired", generation: 3 })).toEqual({ phase: "idle" });
  });

  it("no-speech after words were heard keeps them: the session ends instead of saying it heard nothing", () => {
    const s = run([{ type: "start", generation: 1 }, result(1, "heard"), engine(1, { type: "error", code: "no-speech" })]);
    expect(s).toEqual({ phase: "idle" });
  });

  it("not-allowed → denied, sticky through the engine's end and an abort, until the next start()", () => {
    let s = run([{ type: "start", generation: 1 }, engine(1, { type: "error", code: "not-allowed" })]);
    expect(s).toEqual({ phase: "denied" });
    expect(speechInputReducer(s, engine(1, { type: "end" }))).toBe(s);
    expect(speechInputReducer(s, { type: "abort", generation: 1 })).toBe(s);
    s = speechInputReducer(s, { type: "start", generation: 2 });
    expect(s).toEqual({ phase: "starting", generation: 2 });
  });

  it("aborted → idle silently", () => {
    const s = run([{ type: "start", generation: 1 }, result(1, "x"), engine(1, { type: "error", code: "aborted" })]);
    expect(s).toEqual({ phase: "idle" });
  });

  it("every other code → error(code); the next start() leaves it", () => {
    for (const code of ["audio-capture", "network", "language-not-supported", "other"] as const) {
      const s = run([{ type: "start", generation: 1 }, engine(1, { type: "error", code })]);
      expect(s).toEqual({ phase: "error", code });
      expect(speechInputReducer(s, { type: "start", generation: 2 })).toEqual({ phase: "starting", generation: 2 });
    }
  });

  it("unsupported is inert: no action leaves it", () => {
    const s: SpeechInputState = { phase: "unsupported" };
    for (const a of [
      { type: "start", generation: 1 },
      { type: "stop", generation: 1 },
      { type: "abort", generation: 1 },
      result(1, "x"),
      { type: "no-match-expired", generation: 1 },
    ] satisfies SpeechInputAction[]) {
      expect(speechInputReducer(s, a)).toBe(s);
    }
  });

  it("speechSessionLive is true for starting, listening and stopping only", () => {
    expect(speechSessionLive({ phase: "starting", generation: 1 })).toBe(true);
    expect(speechSessionLive({ phase: "listening", generation: 1, finalText: "", interim: "" })).toBe(true);
    expect(speechSessionLive({ phase: "stopping", generation: 1, finalText: "", interim: "" })).toBe(true);
    for (const s of [
      { phase: "idle" },
      { phase: "unsupported" },
      { phase: "denied" },
      { phase: "no-match", generation: 1 },
      { phase: "error", code: "network" },
    ] satisfies SpeechInputState[]) {
      expect(speechSessionLive(s)).toBe(false);
    }
  });

  it("joinSpeechText joins non-empty parts with one space", () => {
    expect(joinSpeechText("hello", "world")).toBe("hello world");
    expect(joinSpeechText("hello", "")).toBe("hello");
    expect(joinSpeechText("", "world")).toBe("world");
    expect(joinSpeechText("  hello ", " world ")).toBe("hello world");
    expect(joinSpeechText("", "")).toBe("");
  });
});
