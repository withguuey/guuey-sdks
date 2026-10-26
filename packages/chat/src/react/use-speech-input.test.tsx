// @vitest-environment jsdom
/**
 * guuey#2446 — `useSpeechInput`, the React owner of a dictation session:
 * the engine, the generation, the maximum-duration and no-match timers, and
 * the one output, `onTranscript`. Driven with a fake recognizer whose
 * sessions the test steps by hand, including the events a real engine sends
 * AFTER stop() or abort().
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeechRecognizer, SpeechRecognizerEvent, SpeechStartOptions } from "../speech-input.js";
import { useSpeechInput, type SpeechTranscript, type UseSpeechInputOptions } from "./use-speech-input.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface FakeSession {
  opts: SpeechStartOptions;
  stop: Mock<() => void>;
  abort: Mock<() => void>;
  emit(e: SpeechRecognizerEvent): void;
}

function fakeRecognizer(opts: { available?: boolean; throwOnStart?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const recognizer: SpeechRecognizer = {
    isAvailable: () => opts.available !== false,
    start: (startOpts) => {
      if (opts.throwOnStart === true) throw new Error("InvalidStateError");
      const session: FakeSession = {
        opts: startOpts,
        stop: vi.fn<() => void>(),
        abort: vi.fn<() => void>(),
        emit: (e) => act(() => startOpts.onEvent(e)),
      };
      sessions.push(session);
      return { stop: session.stop, abort: session.abort };
    },
  };
  const session = (i: number): FakeSession => {
    const s = sessions[i];
    if (s === undefined) throw new Error(`no session ${i}`);
    return s;
  };
  return { recognizer, sessions, session };
}

function renderSpeech(options: Omit<UseSpeechInputOptions, "onTranscript"> & { onTranscript?: UseSpeechInputOptions["onTranscript"] }) {
  const transcripts: SpeechTranscript[] = [];
  const hook = renderHook((p: UseSpeechInputOptions) => useSpeechInput(p), {
    initialProps: { ...options, onTranscript: options.onTranscript ?? ((t) => transcripts.push(t)) },
  });
  return { ...hook, transcripts };
}

describe("voice: headless hook, useSpeechInput (guuey#2446)", () => {
  it("recognizer: null means unsupported, and start() does nothing", () => {
    const { result } = renderSpeech({ recognizer: null });
    expect(result.current.state).toEqual({ phase: "unsupported" });
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(result.current.state).toEqual({ phase: "unsupported" });
  });

  it("an engine that is not available here is unsupported too", () => {
    const { recognizer, sessions } = fakeRecognizer({ available: false });
    const { result } = renderSpeech({ recognizer });
    expect(result.current.supported).toBe(false);
    act(() => result.current.start());
    expect(sessions).toHaveLength(0);
  });

  it("onTranscript gets whole-session results in order, then one final at end", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result, transcripts } = renderSpeech({ recognizer, lang: "es-ES" });
    expect(result.current.state).toEqual({ phase: "idle" });
    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(session(0).opts.lang).toBe("es-ES");
    session(0).emit({ type: "start" });
    session(0).emit({ type: "result", finalText: "", interim: "hola" });
    session(0).emit({ type: "result", finalText: "hola", interim: "qué" });
    session(0).emit({ type: "result", finalText: "hola qué tal", interim: "" });
    session(0).emit({ type: "end" });
    expect(transcripts).toEqual([
      { finalText: "", interim: "hola", final: false },
      { finalText: "hola", interim: "qué", final: false },
      { finalText: "hola qué tal", interim: "", final: false },
      { finalText: "hola qué tal", interim: "", final: true },
    ]);
    expect(result.current.state).toEqual({ phase: "idle" });
    expect(result.current.listening).toBe(false);
  });

  it("lang left unset is not passed to the engine", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer });
    act(() => result.current.start());
    expect("lang" in session(0).opts).toBe(false);
  });

  it("the max duration STOPS and keeps the text, including the trailing final the engine sends after stop()", () => {
    vi.useFakeTimers();
    const { recognizer, session } = fakeRecognizer();
    const { result, transcripts } = renderSpeech({ recognizer, maxDurationMs: 5_000 });
    act(() => result.current.start());
    session(0).emit({ type: "start" });
    session(0).emit({ type: "result", finalText: "one", interim: "two" });
    act(() => vi.advanceTimersByTime(5_000));
    expect(session(0).stop).toHaveBeenCalledTimes(1);
    expect(session(0).abort).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ phase: "stopping", generation: 1, finalText: "one", interim: "two" });
    session(0).emit({ type: "result", finalText: "one two", interim: "" });
    session(0).emit({ type: "end" });
    expect(transcripts.at(-2)).toEqual({ finalText: "one two", interim: "", final: false });
    expect(transcripts.at(-1)).toEqual({ finalText: "one two", interim: "", final: true });
  });

  it("the max duration defaults to 60 s", () => {
    vi.useFakeTimers();
    const { recognizer, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer });
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(59_999));
    expect(session(0).stop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(session(0).stop).toHaveBeenCalledTimes(1);
  });

  it("the max-duration timer of an ended session never stops the next one", () => {
    vi.useFakeTimers();
    const { recognizer, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer, maxDurationMs: 1_000 });
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(600));
    session(0).emit({ type: "end" });
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(600));
    expect(session(1).stop).not.toHaveBeenCalled();
  });

  it("toggle: idle starts, listening stops, stopping is a no-op", () => {
    const { recognizer, sessions, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer });
    act(() => result.current.toggle());
    expect(sessions).toHaveLength(1);
    session(0).emit({ type: "start" });
    act(() => result.current.toggle());
    expect(session(0).stop).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe("stopping");
    act(() => result.current.toggle());
    act(() => result.current.start());
    expect(session(0).stop).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
  });

  it("unmount aborts the live session", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result, unmount } = renderSpeech({ recognizer });
    act(() => result.current.start());
    unmount();
    expect(session(0).abort).toHaveBeenCalledTimes(1);
  });

  it("subscribeBackground aborts the live session, and is unsubscribed on unmount", () => {
    const { recognizer, session } = fakeRecognizer();
    let onBackground: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const subscribeBackground = (cb: () => void) => {
      onBackground = cb;
      return unsubscribe;
    };
    const { result, unmount } = renderSpeech({ recognizer, subscribeBackground });
    act(() => result.current.start());
    session(0).emit({ type: "start" });
    act(() => onBackground?.());
    expect(session(0).abort).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: "idle" });
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a result the engine sends AFTER abort() reaches no one", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result, transcripts } = renderSpeech({ recognizer });
    act(() => result.current.start());
    session(0).emit({ type: "result", finalText: "kept", interim: "" });
    act(() => result.current.abort());
    expect(session(0).abort).toHaveBeenCalledTimes(1);
    session(0).emit({ type: "result", finalText: "kept and late", interim: "" });
    session(0).emit({ type: "end" });
    expect(transcripts).toEqual([{ finalText: "kept", interim: "", final: false }]);
    expect(result.current.state).toEqual({ phase: "idle" });
  });

  it("a stale session: a result from the previous session, sent after a new start(), reaches no one", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result, transcripts } = renderSpeech({ recognizer });
    act(() => result.current.start());
    session(0).emit({ type: "result", finalText: "first", interim: "" });
    act(() => result.current.stop());
    session(0).emit({ type: "end" });
    act(() => result.current.start());
    session(1).emit({ type: "result", finalText: "second", interim: "" });
    session(0).emit({ type: "result", finalText: "first, slow", interim: "" });
    expect(transcripts.map((t) => t.finalText)).toEqual(["first", "first", "second"]);
    expect(result.current.state).toEqual({ phase: "listening", generation: 2, finalText: "second", interim: "" });
  });

  it("no-speech shows no-match, back to idle after noMatchMs", () => {
    vi.useFakeTimers();
    const { recognizer, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer, noMatchMs: 2_000 });
    act(() => result.current.start());
    session(0).emit({ type: "error", code: "no-speech" });
    session(0).emit({ type: "end" });
    expect(result.current.state.phase).toBe("no-match");
    act(() => vi.advanceTimersByTime(1_999));
    expect(result.current.state.phase).toBe("no-match");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.state).toEqual({ phase: "idle" });
  });

  it("unmount while no-match shows clears its timer: nothing is left to fire", () => {
    vi.useFakeTimers();
    const { recognizer, session } = fakeRecognizer();
    const { result, unmount } = renderSpeech({ recognizer, noMatchMs: 2_000 });
    act(() => result.current.start());
    session(0).emit({ type: "error", code: "no-speech" });
    expect(result.current.state.phase).toBe("no-match");
    // The no-match timer is the one timer left once the session ended.
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(2_000));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("not-allowed is a sticky denied; the next start() tries again", () => {
    const { recognizer, sessions, session } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer });
    act(() => result.current.start());
    session(0).emit({ type: "error", code: "not-allowed" });
    session(0).emit({ type: "end" });
    expect(result.current.state).toEqual({ phase: "denied" });
    act(() => result.current.start());
    expect(sessions).toHaveLength(2);
    expect(result.current.state.phase).toBe("starting");
  });

  it("a session ending on an engine error keeps the words heard so far as the final", () => {
    const { recognizer, session } = fakeRecognizer();
    const { result, transcripts } = renderSpeech({ recognizer });
    act(() => result.current.start());
    session(0).emit({ type: "result", finalText: "half a", interim: "sentence" });
    session(0).emit({ type: "error", code: "network" });
    expect(result.current.state).toEqual({ phase: "error", code: "network" });
    expect(transcripts.at(-1)).toEqual({ finalText: "half a sentence", interim: "", final: true });
  });

  it("a synchronous throw from the engine's start is error: other", () => {
    const { recognizer } = fakeRecognizer({ throwOnStart: true });
    const { result } = renderSpeech({ recognizer });
    act(() => result.current.start());
    expect(result.current.state).toEqual({ phase: "error", code: "other" });
    expect(result.current.listening).toBe(false);
  });

  it("the hook never sends: its only output is onTranscript, and it imports no transport", () => {
    const { recognizer } = fakeRecognizer();
    const { result } = renderSpeech({ recognizer });
    expect(Object.keys(result.current).sort()).toEqual(["abort", "listening", "start", "state", "stop", "supported", "toggle"]);
    const source = readFileSync(join(import.meta.dirname, "use-speech-input.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../speech-input.js", "react"]);
  });
});
