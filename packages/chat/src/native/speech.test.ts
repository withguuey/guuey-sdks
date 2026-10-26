/**
 * guuey#2446 — `expoSpeechRecognizer`, the React Native dictation engine
 * over an INJECTED speech module (the expo-speech-recognition shape). Node,
 * no React Native: the module is a fake object whose listeners the test
 * fires, so the adapter runs anywhere a test can run it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechRecognizerEvent } from "../speech-input.js";
import {
  expoSpeechRecognizer,
  SPEECH_MODULE_END_TIMEOUT_MS,
  type ExpoSpeechEventMap,
  type ExpoSpeechRecognitionLike,
  type ExpoSpeechStartOptions,
} from "./speech.js";

type Listeners = { [K in keyof ExpoSpeechEventMap]: Array<(event: ExpoSpeechEventMap[K]) => void> };

function fakeModule(opts: { available?: boolean; granted?: boolean; throwOnStart?: boolean } = {}) {
  const listeners: Listeners = { start: [], result: [], error: [], end: [], nomatch: [] };
  const calls: string[] = [];
  const started: ExpoSpeechStartOptions[] = [];
  let grant: (granted: boolean) => void = () => undefined;
  const module: ExpoSpeechRecognitionLike = {
    isRecognitionAvailable: () => opts.available !== false,
    requestPermissionsAsync: () => {
      calls.push("permission");
      if (opts.granted !== undefined) return Promise.resolve({ granted: opts.granted });
      return new Promise((resolve) => {
        grant = (granted) => resolve({ granted });
      });
    },
    start: (startOpts) => {
      calls.push("start");
      if (opts.throwOnStart === true) throw new Error("recognizer busy");
      started.push(startOpts);
    },
    stop: () => {
      calls.push("stop");
    },
    abort: () => {
      calls.push("abort");
    },
    addListener: (event, listener) => {
      const list: Array<typeof listener> = listeners[event];
      list.push(listener);
      return {
        remove: () => {
          const i = list.indexOf(listener);
          if (i >= 0) list.splice(i, 1);
        },
      };
    },
  };
  function fire<K extends keyof ExpoSpeechEventMap>(event: K, payload: ExpoSpeechEventMap[K]): void {
    const list: Array<(e: ExpoSpeechEventMap[K]) => void> = listeners[event];
    for (const l of [...list]) l(payload);
  }
  const listenerCount = (): number => Object.values(listeners).reduce((n, l) => n + l.length, 0);
  return { module, calls, started, fire, listenerCount, grant: (granted: boolean) => grant(granted) };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function startWith(module: ExpoSpeechRecognitionLike, lang?: string) {
  const events: SpeechRecognizerEvent[] = [];
  const session = expoSpeechRecognizer(module).start({ ...(lang !== undefined ? { lang } : {}), onEvent: (e) => events.push(e) });
  return { events, session };
}

describe("voice: native engine, expoSpeechRecognizer (guuey#2446)", () => {
  it("isAvailable() is the module's isRecognitionAvailable()", () => {
    expect(expoSpeechRecognizer(fakeModule().module).isAvailable()).toBe(true);
    expect(expoSpeechRecognizer(fakeModule({ available: false }).module).isAvailable()).toBe(false);
  });

  it("awaits permission, then starts continuous with interim results, lang passed through", async () => {
    const fake = fakeModule({ granted: true });
    startWith(fake.module, "ko-KR");
    expect(fake.calls).toEqual(["permission"]);
    await flush();
    expect(fake.calls).toEqual(["permission", "start"]);
    expect(fake.started[0]).toEqual({ lang: "ko-KR", interimResults: true, continuous: true });
  });

  it("lang left unset is not passed to the module", async () => {
    const fake = fakeModule({ granted: true });
    startWith(fake.module);
    await flush();
    expect(fake.started[0]).toEqual({ interimResults: true, continuous: true });
  });

  it("maps the module's events onto the whole session's text: finals accumulate, the interim replaces", async () => {
    const fake = fakeModule({ granted: true });
    const { events } = startWith(fake.module);
    await flush();
    fake.fire("start", null);
    fake.fire("result", { isFinal: false, results: [{ transcript: "good" }] });
    fake.fire("result", { isFinal: true, results: [{ transcript: "good morning" }] });
    fake.fire("result", { isFinal: false, results: [{ transcript: "how are" }] });
    fake.fire("result", { isFinal: true, results: [{ transcript: " how are you " }] });
    fake.fire("end", null);
    expect(events).toEqual([
      { type: "start" },
      { type: "result", finalText: "", interim: "good" },
      { type: "result", finalText: "good morning", interim: "" },
      { type: "result", finalText: "good morning", interim: "how are" },
      { type: "result", finalText: "good morning how are you", interim: "" },
      { type: "end" },
    ]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("maps the module's error codes onto the kit's", async () => {
    const table: Array<[string, SpeechRecognizerEvent]> = [
      ["not-allowed", { type: "error", code: "not-allowed" }],
      ["service-not-allowed", { type: "error", code: "not-allowed" }],
      ["no-speech", { type: "error", code: "no-speech" }],
      ["speech-timeout", { type: "error", code: "no-speech" }],
      ["audio-capture", { type: "error", code: "audio-capture" }],
      ["network", { type: "error", code: "network" }],
      ["language-not-supported", { type: "error", code: "language-not-supported" }],
      ["aborted", { type: "error", code: "aborted" }],
      ["busy", { type: "error", code: "other" }],
      ["unknown", { type: "error", code: "other" }],
    ];
    for (const [error, expected] of table) {
      const fake = fakeModule({ granted: true });
      const { events } = startWith(fake.module);
      await flush();
      fake.fire("error", { error, message: "" });
      expect(events, error).toEqual([expected]);
    }
  });

  it("nomatch with nothing heard is no-speech; after words were heard it is ignored", async () => {
    const fake = fakeModule({ granted: true });
    const { events } = startWith(fake.module);
    await flush();
    fake.fire("nomatch", null);
    expect(events).toEqual([{ type: "error", code: "no-speech" }]);

    const heard = fakeModule({ granted: true });
    const second = startWith(heard.module);
    await flush();
    heard.fire("result", { isFinal: true, results: [{ transcript: "hi" }] });
    heard.fire("nomatch", null);
    expect(second.events).toEqual([{ type: "result", finalText: "hi", interim: "" }]);
  });

  it("a requestPermissionsAsync refusal is not-allowed (the hook's denied), and nothing starts", async () => {
    const fake = fakeModule({ granted: false });
    const { events } = startWith(fake.module);
    await flush();
    expect(events).toEqual([{ type: "error", code: "not-allowed" }]);
    expect(fake.calls).toEqual(["permission"]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("abort() before permission resolves starts nothing and reports nothing", async () => {
    const fake = fakeModule();
    const { events, session } = startWith(fake.module);
    session.abort();
    fake.grant(true);
    await flush();
    expect(fake.calls).toEqual(["permission"]);
    expect(events).toEqual([]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("stop() before permission resolves starts nothing and ends the session", async () => {
    const fake = fakeModule();
    const { events, session } = startWith(fake.module);
    session.stop();
    fake.grant(true);
    await flush();
    expect(fake.calls).toEqual(["permission"]);
    expect(events).toEqual([{ type: "end" }]);
  });

  it("stop() after start asks the module to finish; its trailing final and end still arrive", async () => {
    const fake = fakeModule({ granted: true });
    const { events, session } = startWith(fake.module);
    await flush();
    session.stop();
    expect(fake.calls).toEqual(["permission", "start", "stop"]);
    fake.fire("result", { isFinal: true, results: [{ transcript: "last words" }] });
    fake.fire("end", null);
    expect(events).toEqual([{ type: "result", finalText: "last words", interim: "" }, { type: "end" }]);
  });

  it("abort() after start aborts the module, removes the session's listeners, and forwards nothing more", async () => {
    const fake = fakeModule({ granted: true });
    const { events, session } = startWith(fake.module);
    await flush();
    session.abort();
    expect(fake.calls).toEqual(["permission", "start", "abort"]);
    // Only the drain's wait for the module's end is left.
    expect(fake.listenerCount()).toBe(1);
    fake.fire("result", { isFinal: true, results: [{ transcript: "late" }] });
    fake.fire("end", null);
    expect(events).toEqual([]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("one module, two sessions: an aborted session's late result and end reach neither session, and the next starts only after that end", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    const first = recognizer.start({ onEvent: (e) => a.push(e) });
    await flush();
    fake.fire("start", null);
    first.abort();
    recognizer.start({ onEvent: (e) => b.push(e) });
    await flush();
    // The module still owes the aborted session its leftovers.
    fake.fire("result", { isFinal: true, results: [{ transcript: "old words" }] });
    fake.fire("error", { error: "aborted", message: "" });
    fake.fire("end", null);
    expect(b).toEqual([]);
    expect(a).toEqual([{ type: "start" }]);
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission"]);
    await flush();
    // The previous session drained: the next one starts, and hears only itself.
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start"]);
    fake.fire("start", null);
    fake.fire("result", { isFinal: false, results: [{ transcript: "new" }] });
    expect(b).toEqual([{ type: "start" }, { type: "result", finalText: "", interim: "new" }]);
  });

  it("one module, two sessions: stop() then a quick start() leaves the stopped session's trailing final and end to it alone", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    const first = recognizer.start({ onEvent: (e) => a.push(e) });
    await flush();
    first.stop();
    recognizer.start({ onEvent: (e) => b.push(e) });
    await flush();
    fake.fire("result", { isFinal: true, results: [{ transcript: "last words" }] });
    fake.fire("end", null);
    expect(a).toEqual([{ type: "result", finalText: "last words", interim: "" }, { type: "end" }]);
    expect(b).toEqual([]);
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "stop", "permission", "start"]);
    fake.fire("result", { isFinal: true, results: [{ transcript: "fresh" }] });
    expect(b).toEqual([{ type: "result", finalText: "fresh", interim: "" }]);
    expect(a).toHaveLength(2);
  });

  it("a session waiting for the previous one to drain: abort() starts nothing, stop() starts nothing and ends it", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const first = recognizer.start({ onEvent: () => undefined });
    await flush();
    first.abort();
    const aborted: SpeechRecognizerEvent[] = [];
    recognizer.start({ onEvent: (e) => aborted.push(e) }).abort();
    const stopped: SpeechRecognizerEvent[] = [];
    const waiting = recognizer.start({ onEvent: (e) => stopped.push(e) });
    await flush();
    waiting.stop();
    expect(stopped).toEqual([{ type: "end" }]);
    fake.fire("end", null);
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "permission"]);
    expect(aborted).toEqual([]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("two recognizers over the same module share the drain: the module is the one shared resource", async () => {
    const fake = fakeModule({ granted: true });
    const first = expoSpeechRecognizer(fake.module).start({ onEvent: () => undefined });
    await flush();
    first.abort();
    const b: SpeechRecognizerEvent[] = [];
    expoSpeechRecognizer(fake.module).start({ onEvent: (e) => b.push(e) });
    await flush();
    fake.fire("result", { isFinal: true, results: [{ transcript: "old words" }] });
    fake.fire("end", null);
    expect(b).toEqual([]);
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start"]);
  });

  it("an engine error while running drains too: the module's end for that session reaches no later session", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    recognizer.start({ onEvent: (e) => a.push(e) });
    await flush();
    fake.fire("error", { error: "network", message: "" });
    expect(a).toEqual([{ type: "error", code: "network" }]);
    recognizer.start({ onEvent: (e) => b.push(e) });
    await flush();
    // The module still owes the failed session its end.
    expect(fake.calls).toEqual(["permission", "start", "permission"]);
    fake.fire("end", null);
    expect(b).toEqual([]);
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "permission", "start"]);
    fake.fire("result", { isFinal: false, results: [{ transcript: "new" }] });
    expect(b).toEqual([{ type: "result", finalText: "", interim: "new" }]);
  });

  it("a nomatch reported as no-speech drains too: the module's end for that session reaches no later session", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    recognizer.start({ onEvent: (e) => a.push(e) });
    await flush();
    fake.fire("nomatch", null);
    expect(a).toEqual([{ type: "error", code: "no-speech" }]);
    recognizer.start({ onEvent: (e) => b.push(e) });
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "permission"]);
    fake.fire("end", null);
    expect(b).toEqual([]);
    await flush();
    expect(fake.calls).toEqual(["permission", "start", "permission", "start"]);
  });

  it("an engine error or a nomatch ends the session at once: only the drain's end listener is left, and the module's end reaches the ended session no more", async () => {
    for (const fireEnding of [
      (fake: ReturnType<typeof fakeModule>) => fake.fire("error", { error: "network", message: "" }),
      (fake: ReturnType<typeof fakeModule>) => fake.fire("nomatch", null),
    ]) {
      const fake = fakeModule({ granted: true });
      const { events } = startWith(fake.module);
      await flush();
      fireEnding(fake);
      expect(events).toHaveLength(1);
      // The session's five listeners are gone; the drain's wait for end remains.
      expect(fake.listenerCount()).toBe(1);
      const reported = [...events];
      fake.fire("start", null);
      fake.fire("result", { isFinal: false, results: [{ transcript: "late" }] });
      fake.fire("end", null);
      expect(events).toEqual(reported);
      expect(fake.listenerCount()).toBe(0);
    }
  });

  it("a throw from the module's start, or a rejected permission request, is error: other", async () => {
    const throwing = fakeModule({ granted: true, throwOnStart: true });
    const first = startWith(throwing.module);
    await flush();
    expect(first.events).toEqual([{ type: "error", code: "other" }]);
    expect(throwing.listenerCount()).toBe(0);

    const rejecting = fakeModule();
    rejecting.module.requestPermissionsAsync = () => Promise.reject(new Error("no permission API"));
    const second = startWith(rejecting.module);
    await flush();
    expect(second.events).toEqual([{ type: "error", code: "other" }]);
  });

  it("the adapter imports no native package: only the kit's own core, as types", () => {
    const source = readFileSync(join(import.meta.dirname, "speech.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].map((m) => [m[1] !== undefined, m[2]]);
    expect(imports).toEqual([[true, "../speech-input.js"]]);
    expect(source).not.toMatch(/require\(|import\(/);
  });
});

describe("voice: native engine, the bounded drain (guuey#2446)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const tick = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it("a module that never sends end after abort wedges no later session: the next one starts once the bound passes", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const first = recognizer.start({ onEvent: () => undefined });
    await tick();
    first.abort();
    const b: SpeechRecognizerEvent[] = [];
    recognizer.start({ onEvent: (e) => b.push(e) });
    await tick();
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission"]);
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS - 1);
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start"]);
    // The drain's own end listener is gone; only the new session's five remain.
    expect(fake.listenerCount()).toBe(5);
    fake.fire("result", { isFinal: false, results: [{ transcript: "new" }] });
    expect(b).toEqual([{ type: "result", finalText: "", interim: "new" }]);
  });

  it("an error whose module never sends end: once the bound passes, the next session's events reach only that session", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    recognizer.start({ onEvent: (e) => a.push(e) });
    await tick();
    fake.fire("error", { error: "network", message: "" });
    expect(a).toEqual([{ type: "error", code: "network" }]);
    recognizer.start({ onEvent: (e) => b.push(e) });
    await tick();
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS);
    expect(fake.calls).toEqual(["permission", "start", "permission", "start"]);
    expect(fake.listenerCount()).toBe(5);
    fake.fire("start", null);
    fake.fire("result", { isFinal: false, results: [{ transcript: "new" }] });
    expect(b).toEqual([{ type: "start" }, { type: "result", finalText: "", interim: "new" }]);
    expect(a).toEqual([{ type: "error", code: "network" }]);
  });

  it("a stop whose module never sends end: the bound ends that session, and the next session's events reach only the next one", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const a: SpeechRecognizerEvent[] = [];
    const b: SpeechRecognizerEvent[] = [];
    const first = recognizer.start({ onEvent: (e) => a.push(e) });
    await tick();
    first.stop();
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS - 1);
    // Still waiting for the module's end: the stopped session has ended nothing yet.
    expect(a).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The bound ended it, as a late end would, and took its listeners with it.
    expect(a).toEqual([{ type: "end" }]);
    expect(fake.listenerCount()).toBe(0);
    recognizer.start({ onEvent: (e) => b.push(e) });
    await tick();
    expect(fake.listenerCount()).toBe(5);
    fake.fire("start", null);
    fake.fire("result", { isFinal: false, results: [{ transcript: "new" }] });
    expect(b).toEqual([{ type: "start" }, { type: "result", finalText: "", interim: "new" }]);
    expect(a).toEqual([{ type: "end" }]);
  });

  it("a stop while another session's drain is pending: the shared bound still ends the stopped session", async () => {
    const fake = fakeModule({ granted: true });
    const a: SpeechRecognizerEvent[] = [];
    // Two recognizers over one module, both running before either owes an end.
    const first = expoSpeechRecognizer(fake.module).start({ onEvent: (e) => a.push(e) });
    const second = expoSpeechRecognizer(fake.module).start({ onEvent: () => undefined });
    await tick();
    second.abort();
    first.stop();
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS);
    expect(a).toEqual([{ type: "end" }]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("an end that arrives first settles the drain once: its timer is cleared and cannot settle a later drain", async () => {
    const fake = fakeModule({ granted: true });
    const recognizer = expoSpeechRecognizer(fake.module);
    const first = recognizer.start({ onEvent: () => undefined });
    await tick();
    first.abort();
    expect(vi.getTimerCount()).toBe(1);
    fake.fire("end", null);
    expect(vi.getTimerCount()).toBe(0);
    const second = recognizer.start({ onEvent: () => undefined });
    await tick();
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start"]);
    // Half the bound later the second session is aborted and owes its own end.
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS / 2);
    second.abort();
    // Past where the first drain's timer would have fired, the second drain still holds.
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS / 2 + 1);
    recognizer.start({ onEvent: () => undefined });
    await tick();
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start", "abort", "permission"]);
    // The second drain's own bound releases it.
    await vi.advanceTimersByTimeAsync(SPEECH_MODULE_END_TIMEOUT_MS / 2);
    expect(fake.calls).toEqual(["permission", "start", "abort", "permission", "start", "abort", "permission", "start"]);
  });
});
