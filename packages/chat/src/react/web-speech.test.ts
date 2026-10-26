// @vitest-environment jsdom
/**
 * guuey#2446 — `webSpeechRecognizer`, the web engine over the Web Speech
 * API (`SpeechRecognition` / `webkitSpeechRecognition`). jsdom has neither,
 * so each test stubs the constructor: on a passed window object, or on the
 * real `window` for the default.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SpeechRecognizerEvent } from "../speech-input.js";
import {
  webSpeechRecognizer,
  type WebSpeechRecognitionLike,
  type WebSpeechResultListLike,
  type WebSpeechWindow,
} from "./web-speech.js";

/** A Web Speech stub that records every instance and the calls on it. */
function stubConstructor(opts: { throwOnStart?: boolean } = {}) {
  const instances: FakeRecognition[] = [];
  class FakeRecognition implements WebSpeechRecognitionLike {
    continuous = false;
    interimResults = false;
    lang = "";
    onstart: (() => void) | null = null;
    onresult: ((ev: { readonly results: WebSpeechResultListLike }) => void) | null = null;
    onerror: ((ev: { readonly error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    calls: string[] = [];
    constructor() {
      instances.push(this);
    }
    start(): void {
      this.calls.push("start");
      if (opts.throwOnStart === true) throw new DOMException("already started", "InvalidStateError");
    }
    stop(): void {
      this.calls.push("stop");
    }
    abort(): void {
      this.calls.push("abort");
    }
  }
  return { Ctor: FakeRecognition, instances };
}

/** A results list the way the API delivers it: every segment of the session from index 0. */
function results(...segments: Array<[transcript: string, isFinal: boolean]>): WebSpeechResultListLike {
  const list: { length: number; [index: number]: { isFinal: boolean; length: number; 0: { transcript: string } } } = {
    length: segments.length,
  };
  segments.forEach(([transcript, isFinal], i) => {
    list[i] = { isFinal, length: 1, 0: { transcript } };
  });
  return list;
}

function fakeDocument() {
  return Object.assign(new EventTarget(), { visibilityState: "visible" as string });
}

function startWith(win: WebSpeechWindow, lang?: string) {
  const events: SpeechRecognizerEvent[] = [];
  const session = webSpeechRecognizer(win).start({ ...(lang !== undefined ? { lang } : {}), onEvent: (e) => events.push(e) });
  return { events, session };
}

afterEach(() => {
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
});

describe("voice: web engine, webSpeechRecognizer (guuey#2446)", () => {
  it("absent API means isAvailable() is false (Firefox, SSR)", () => {
    expect(webSpeechRecognizer({}).isAvailable()).toBe(false);
    expect(webSpeechRecognizer().isAvailable()).toBe(false);
  });

  it("reads SpeechRecognition first, else webkitSpeechRecognition, and constructs nothing until start", () => {
    const standard = stubConstructor();
    const prefixed = stubConstructor();
    const both = webSpeechRecognizer({ SpeechRecognition: standard.Ctor, webkitSpeechRecognition: prefixed.Ctor });
    expect(both.isAvailable()).toBe(true);
    expect(standard.instances).toHaveLength(0);
    both.start({ onEvent: () => undefined });
    expect(standard.instances).toHaveLength(1);
    expect(prefixed.instances).toHaveLength(0);

    const onlyPrefixed = stubConstructor();
    webSpeechRecognizer({ webkitSpeechRecognition: onlyPrefixed.Ctor }).start({ onEvent: () => undefined });
    expect(onlyPrefixed.instances).toHaveLength(1);
  });

  it("defaults to globalThis: a stub on window is found", () => {
    const { Ctor, instances } = stubConstructor();
    Object.assign(window, { webkitSpeechRecognition: Ctor });
    const recognizer = webSpeechRecognizer();
    expect(recognizer.isAvailable()).toBe(true);
    recognizer.start({ onEvent: () => undefined });
    expect(instances[0]?.calls).toEqual(["start"]);
  });

  it("starts continuous with interim results; lang is passed through, and left unset when undefined", () => {
    const { Ctor, instances } = stubConstructor();
    startWith({ SpeechRecognition: Ctor }, "fr-FR");
    expect(instances[0]).toMatchObject({ continuous: true, interimResults: true, lang: "fr-FR" });
    startWith({ SpeechRecognition: Ctor });
    expect(instances[1]?.lang).toBe("");
  });

  it("folds event.results from index 0 into the whole session's { finalText, interim }", () => {
    const { Ctor, instances } = stubConstructor();
    const { events } = startWith({ SpeechRecognition: Ctor });
    const rec = instances[0];
    rec?.onstart?.();
    rec?.onresult?.({ results: results(["hello", false]) });
    rec?.onresult?.({ results: results(["hello", true], [" world", true], [" how ar", false]) });
    rec?.onresult?.({ results: results(["hello", true], [" world", true], [" how are you", true]) });
    rec?.onend?.();
    expect(events).toEqual([
      { type: "start" },
      { type: "result", finalText: "", interim: "hello" },
      { type: "result", finalText: "hello world", interim: "how ar" },
      { type: "result", finalText: "hello world how are you", interim: "" },
      { type: "end" },
    ]);
  });

  it("maps every SpeechRecognitionErrorEvent.error onto the kit's codes", () => {
    const table: Array<[string, SpeechRecognizerEvent]> = [
      ["not-allowed", { type: "error", code: "not-allowed" }],
      ["service-not-allowed", { type: "error", code: "not-allowed" }],
      ["no-speech", { type: "error", code: "no-speech" }],
      ["audio-capture", { type: "error", code: "audio-capture" }],
      ["network", { type: "error", code: "network" }],
      ["language-not-supported", { type: "error", code: "language-not-supported" }],
      ["aborted", { type: "error", code: "aborted" }],
      ["bad-grammar", { type: "error", code: "other" }],
      ["something-new", { type: "error", code: "other" }],
    ];
    for (const [error, expected] of table) {
      const { Ctor, instances } = stubConstructor();
      const { events } = startWith({ SpeechRecognition: Ctor });
      instances[0]?.onerror?.({ error });
      expect(events, error).toEqual([expected]);
    }
  });

  it("a throw from start() (InvalidStateError) is error: other", () => {
    const { Ctor } = stubConstructor({ throwOnStart: true });
    const { events } = startWith({ SpeechRecognition: Ctor });
    expect(events).toEqual([{ type: "error", code: "other" }]);
  });

  it("stop() asks the engine to finish; its trailing result and end still arrive", () => {
    const { Ctor, instances } = stubConstructor();
    const { events, session } = startWith({ SpeechRecognition: Ctor });
    session.stop();
    expect(instances[0]?.calls).toEqual(["start", "stop"]);
    instances[0]?.onresult?.({ results: results(["last", true]) });
    instances[0]?.onend?.();
    expect(events).toEqual([{ type: "result", finalText: "last", interim: "" }, { type: "end" }]);
  });

  it("abort() aborts the engine, and nothing it reports afterwards is forwarded", () => {
    const { Ctor, instances } = stubConstructor();
    const { events, session } = startWith({ SpeechRecognition: Ctor });
    session.abort();
    expect(instances[0]?.calls).toEqual(["start", "abort"]);
    instances[0]?.onresult?.({ results: results(["late", true]) });
    instances[0]?.onerror?.({ error: "aborted" });
    instances[0]?.onend?.();
    expect(events).toEqual([]);
  });

  it("a hidden page aborts the session and reports it aborted; a visible change does not", () => {
    const { Ctor, instances } = stubConstructor();
    const document = fakeDocument();
    const { events } = startWith({ SpeechRecognition: Ctor, document });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(instances[0]?.calls).toEqual(["start"]);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(instances[0]?.calls).toEqual(["start", "abort"]);
    expect(events).toEqual([{ type: "error", code: "aborted" }]);
    instances[0]?.onresult?.({ results: results(["late", true]) });
    instances[0]?.onend?.();
    expect(events).toEqual([{ type: "error", code: "aborted" }]);
  });

  it("the visibility listener goes when the session ends", () => {
    const { Ctor, instances } = stubConstructor();
    const document = fakeDocument();
    startWith({ SpeechRecognition: Ctor, document });
    instances[0]?.onend?.();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(instances[0]?.calls).toEqual(["start"]);
  });
});
