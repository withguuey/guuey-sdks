// @vitest-environment jsdom
/**
 * guuey#2446 — `<GuueyChat voice>`: composer dictation over the browser's
 * Web Speech API. Off by default (an off chat reads no speech API at all);
 * on, a mic button beside the field puts the person's words IN THE FIELD and
 * nothing else: no speech event ever sends a turn, the person edits and
 * presses Send. Rendered over the real hook stack with a scripted transport
 * and a Web Speech stub on `window` whose instances the test drives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatProps } from "./guuey-chat.js";
import { PARTS } from "./parts.js";
import { defaultChatStrings } from "../strings.js";
import type { WebSpeechRecognitionLike, WebSpeechResultListLike } from "./web-speech.js";

const ENDPOINT = "https://pod.example/agent/invoke";
const S = defaultChatStrings;

/** Every Web Speech instance the kit constructed, and how often the page's constructors were read. */
const speech = { instances: [] as FakeRecognition[], reads: 0 };

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
    speech.instances.push(this);
  }
  start(): void {
    this.calls.push("start");
  }
  stop(): void {
    this.calls.push("stop");
  }
  abort(): void {
    this.calls.push("abort");
  }
  /** The engine reports the whole session: `finals` then one interim segment. */
  say(finals: readonly string[], interim = ""): void {
    const segments: Array<[string, boolean]> = [...finals.map((f): [string, boolean] => [f, true])];
    if (interim !== "") segments.push([interim, false]);
    const list: { length: number; [index: number]: { isFinal: boolean; length: number; 0: { transcript: string } } } = {
      length: segments.length,
    };
    segments.forEach(([transcript, isFinal], i) => {
      list[i] = { isFinal, length: 1, 0: { transcript } };
    });
    act(() => this.onresult?.({ results: list }));
  }
  begin(): void {
    act(() => this.onstart?.());
  }
  end(): void {
    act(() => this.onend?.());
  }
  fail(error: string): void {
    act(() => this.onerror?.({ error }));
  }
}

function installSpeech(): void {
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    get: () => {
      speech.reads += 1;
      return FakeRecognition;
    },
  });
}

/** Counts reads of both constructors without providing either (an off chat must read neither). */
function watchSpeechReads(): void {
  for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    Object.defineProperty(window, name, {
      configurable: true,
      get: () => {
        speech.reads += 1;
        return undefined;
      },
    });
  }
}

function rec(i: number): FakeRecognition {
  const r = speech.instances[i];
  if (r === undefined) throw new Error(`no recognition ${i}`);
  return r;
}

beforeEach(() => {
  speech.instances = [];
  speech.reads = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
});

const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function podAdapters(opts: { closeThread?: boolean } = {}) {
  const calls: InvokeRequest[] = [];
  const adapters: AgentInvokeAdapters = {
    storage: { load: () => null, save: () => undefined },
    generateId: (() => {
      let n = 0;
      return () => `cmid-${n++}`;
    })(),
    transport: async function* (req) {
      calls.push(req);
      yield frame("session", { threadId: "t-voice" });
      if (opts.closeThread === true) {
        const closed = { code: "app:CHAT_FULL", message: "Full.", closedAt: "2026-10-27T00:00:00.000Z" };
        yield frame("error", { code: closed.code, message: closed.message, threadClosed: closed });
        yield frame("done", { stopReason: "end_turn", threadId: "t-voice", threadClosed: closed });
        return;
      }
      yield frame("message", { type: "text.delta", delta: "Got it." });
      yield frame("done", { stopReason: "end" });
    },
  };
  return { adapters, calls };
}

function renderChat(adapters: AgentInvokeAdapters, props: Partial<GuueyChatProps> = {}) {
  return render(<GuueyChat endpointUrl={ENDPOINT} adapters={adapters} voice {...props} />);
}

const field = (): HTMLTextAreaElement => {
  const el = screen.getByLabelText(S.composerLabel);
  if (!(el instanceof HTMLTextAreaElement)) throw new Error("no composer field");
  return el;
};
const mic = (): HTMLButtonElement => {
  const el = screen.getByRole("button", { name: S.voiceInput });
  if (!(el instanceof HTMLButtonElement)) throw new Error("no mic button");
  return el;
};

describe("<GuueyChat voice> (guuey#2446)", () => {
  it("is off by default: no mic, and the page's speech API is never read, even across a send", async () => {
    watchSpeechReads();
    const { adapters, calls } = podAdapters();
    render(<GuueyChat endpointUrl={ENDPOINT} adapters={adapters} />);
    expect(screen.queryByRole("button", { name: S.voiceInput })).toBeNull();
    fireEvent.change(field(), { target: { value: "hi" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(speech.reads).toBe(0);
    expect(speech.instances).toHaveLength(0);
  });

  it("on, but the API is missing (Firefox): no mic", () => {
    const { adapters } = podAdapters();
    renderChat(adapters);
    expect(screen.queryByRole("button", { name: S.voiceInput })).toBeNull();
  });

  it("on: a labelled type=button mic with aria-pressed and its part; pressing it starts a session in voiceLang", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters, { voiceLang: "es-ES" });
    const button = mic();
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe(S.voiceInput);
    expect(button.getAttribute("part")).toBe(PARTS.composerVoice);
    expect(button.className).toBe("guuey-chat-composer-voice");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(speech.instances).toHaveLength(0);
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(rec(0)).toMatchObject({ lang: "es-ES", continuous: true, interimResults: true });
    expect(rec(0).calls).toEqual(["start"]);
  });

  it("into the field: interim results replace one another after the draft and one space; the final stays; zero posts", () => {
    installSpeech();
    const { adapters, calls } = podAdapters();
    renderChat(adapters);
    fireEvent.change(field(), { target: { value: "Draft:" } });
    fireEvent.click(mic());
    rec(0).begin();
    rec(0).say([], "hel");
    expect(field().value).toBe("Draft: hel");
    rec(0).say([], "hello wor");
    expect(field().value).toBe("Draft: hello wor");
    rec(0).say(["hello world"]);
    expect(field().value).toBe("Draft: hello world");
    rec(0).end();
    expect(field().value).toBe("Draft: hello world");
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    expect(calls).toHaveLength(0);
  });

  it("stopping by the mic: the last sentence's final, sent after stop() and before end, lands with zero posts", () => {
    installSpeech();
    const { adapters, calls } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    rec(0).begin();
    rec(0).say(["one"], "two");
    fireEvent.click(mic());
    expect(rec(0).calls).toEqual(["start", "stop"]);
    rec(0).say(["one", "two three"]);
    expect(field().value).toBe("one two three");
    rec(0).end();
    expect(field().value).toBe("one two three");
    expect(calls).toHaveLength(0);
  });

  it("a stale session: a late result from the first session leaves the field as the second session draws it", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    rec(0).say(["first"]);
    fireEvent.click(mic());
    rec(0).end();
    fireEvent.click(mic());
    rec(1).say(["second"]);
    rec(0).say(["first", "slow"]);
    expect(field().value).toBe("first second");
  });

  it("the person edits while listening: the session aborts and the edit stands", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    rec(0).say(["hello"]);
    fireEvent.change(field(), { target: { value: "hello there" } });
    expect(rec(0).calls).toEqual(["start", "abort"]);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    rec(0).say(["hello world"]);
    rec(0).end();
    expect(field().value).toBe("hello there");
  });

  it("status lines: listening while live; no-speech says it didn't catch that, then clears; not-allowed says it is blocked", () => {
    vi.useFakeTimers();
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    expect(screen.getByRole("status").textContent).toBe(S.voiceListening);
    rec(0).fail("no-speech");
    rec(0).end();
    expect(screen.getByText(S.voiceNoMatch)).toBeTruthy();
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText(S.voiceNoMatch)).toBeNull();
    fireEvent.click(mic());
    rec(1).fail("not-allowed");
    rec(1).end();
    expect(screen.getByText(S.voiceDenied)).toBeTruthy();
    fireEvent.click(mic());
    rec(2).fail("network");
    expect(screen.getByText(S.voiceError)).toBeTruthy();
  });

  it("the status line is placed like the attachment notice: the composer form's own row, above the field and its buttons", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters, { attachments: true });
    fireEvent.click(mic());
    const status = screen.getByRole("status");
    expect(status.className).toBe("guuey-chat-voice-status");
    const form = field().closest("form");
    expect(status.parentElement).toBe(form);
    // Before the mic, the field and Send, exactly where the attachment notice sits.
    for (const later of [mic(), field(), screen.getByRole("button", { name: S.send })]) {
      expect(status.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("sending while listening aborts and sends the field's text; a final sent after the send leaves the field empty", async () => {
    installSpeech();
    const { adapters, calls } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    rec(0).say(["send this"]);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(rec(0).calls).toEqual(["start", "abort"]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ input: "send this" });
    rec(0).say(["send this", "and more"]);
    rec(0).end();
    expect(field().value).toBe("");
    await waitFor(() => expect(screen.getByText("Got it.")).toBeTruthy());
    expect(calls).toHaveLength(1);
  });

  it("Enter while the agent is streaming sends nothing and leaves the dictation alive", async () => {
    installSpeech();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: InvokeRequest[] = [];
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => undefined },
      generateId: (() => {
        let n = 0;
        return () => `cmid-${n++}`;
      })(),
      transport: async function* (req) {
        calls.push(req);
        yield frame("session", { threadId: "t-voice" });
        yield frame("message", { type: "text.delta", delta: "Working" });
        await held;
        yield frame("done", { stopReason: "end" });
      },
    };
    renderChat(adapters);
    fireEvent.change(field(), { target: { value: "first" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: S.stop })).toBeTruthy());
    fireEvent.click(mic());
    rec(0).say(["while it works"]);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(rec(0).calls).toEqual(["start"]);
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    rec(0).say(["while it works", "and more"]);
    expect(field().value).toBe("while it works and more");
    expect(calls).toHaveLength(1);
    await act(async () => {
      release();
      await held;
    });
  });

  it("the Send button while listening does the same", async () => {
    installSpeech();
    const { adapters, calls } = podAdapters();
    renderChat(adapters);
    fireEvent.click(mic());
    rec(0).say(["by the button"]);
    fireEvent.click(screen.getByRole("button", { name: S.send }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ input: "by the button" });
    expect(rec(0).calls).toEqual(["start", "abort"]);
  });

  it("gates: disabled while the chat is unavailable, and the gate closing mid-session aborts", () => {
    installSpeech();
    const { adapters } = podAdapters();
    const { rerender } = renderChat(adapters);
    fireEvent.click(mic());
    rec(0).say(["half"]);
    rerender(<GuueyChat endpointUrl={null} adapters={adapters} voice />);
    expect(rec(0).calls).toEqual(["start", "abort"]);
    expect(mic().disabled).toBe(true);
    expect(field().value).toBe("half");
  });

  it("gates: disabled on a closed conversation", async () => {
    installSpeech();
    const { adapters, calls } = podAdapters({ closeThread: true });
    renderChat(adapters);
    fireEvent.change(field(), { target: { value: "hello" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(S.threadClosedTitle)).toBeTruthy());
    expect(mic().disabled).toBe(true);
  });

  it("gates: disabled while an upfront connection is required", async () => {
    installSpeech();
    const ask = {
      askId: "mcp-oauth:app_1:linear:t-voice",
      kind: "auth",
      message: "Trip Planner wants to use your Linear account",
      authConfig: { scheme: "oauth2", authorizationUrl: "https://mcp.example/oauth/start?state=" + "a".repeat(64) },
      grantModes: [{ id: "always", label: "Always allow" }],
      metadata: { appId: "app_1", serverName: "linear", displayName: "Linear", authMode: "upfront" },
    };
    const calls: InvokeRequest[] = [];
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => undefined },
      generateId: () => "cmid-auth",
      transport: async function* (req) {
        calls.push(req);
        yield frame("session", { threadId: "t-voice" });
        yield frame("message", { type: "turn.start", seq: 0, turnId: "a#turn", threadId: "t-voice" });
        yield frame("message", { type: "hitl.ask", seq: 1, turnId: "a#turn", continuation: "turn", ...ask });
        yield frame("message", { type: "turn.done", seq: 2, turnId: "a#turn", finishReason: "paused", outcome: { type: "paused", asks: [ask] } });
        yield frame("done", { stopReason: "end" });
      },
    };
    renderChat(adapters);
    fireEvent.change(field(), { target: { value: "hi" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(field().disabled).toBe(true));
    expect(mic().disabled).toBe(true);
  });

  it("analytics: a mic start is the interaction, so opened fires", () => {
    installSpeech();
    const sink = vi.fn();
    const { adapters } = podAdapters();
    renderChat(adapters, { appId: "app_1", analytics: sink });
    fireEvent.click(mic());
    expect(sink.mock.calls).toEqual([["helper_opened", { app_id: "app_1", surface: "inline", gui: "on" }]]);
  });

  it("string overrides reach the mic and the status line", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters, { strings: { voiceInput: "Dictar", voiceListening: "Escuchando…" } });
    const button = screen.getByRole("button", { name: "Dictar" });
    expect(button.getAttribute("title")).toBe("Dictar");
    fireEvent.click(button);
    expect(screen.getByRole("status").textContent).toBe("Escuchando…");
  });

  it("composer={false}: no mic", () => {
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters, { composer: false });
    expect(screen.queryByRole("button", { name: S.voiceInput })).toBeNull();
  });

  it("the max duration stops the session and keeps its words", () => {
    vi.useFakeTimers();
    installSpeech();
    const { adapters } = podAdapters();
    renderChat(adapters, { voiceMaxDurationMs: 10_000 });
    fireEvent.click(mic());
    rec(0).say(["long", "talk"]);
    act(() => vi.advanceTimersByTime(10_000));
    expect(rec(0).calls).toEqual(["start", "stop"]);
    rec(0).end();
    expect(field().value).toBe("long talk");
  });

  it("SSR: the server renders no mic, hydration does not mismatch, and the mic appears after hydration", async () => {
    installSpeech();
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const { adapters } = podAdapters();
    const el = <GuueyChat endpointUrl={ENDPOINT} adapters={adapters} voice />;
    const host = document.createElement("div");
    host.innerHTML = renderToString(el);
    expect(host.querySelector(".guuey-chat-composer-voice")).toBeNull();
    document.body.appendChild(host);
    const root = await act(async () => hydrateRoot(host, el));
    expect(errors.filter((e) => /hydrat|418|did not match/i.test(e))).toEqual([]);
    expect(host.querySelector(".guuey-chat-composer-voice")).not.toBeNull();
    vi.restoreAllMocks();
    act(() => root.unmount());
    host.remove();
  });
});
