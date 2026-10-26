/**
 * guuey#2446 — `useSpeechInput`, the headless dictation hook: one session at
 * a time over an INJECTED {@link SpeechRecognizer}, reporting the session's
 * text to the host through `onTranscript`. The host decides where the words
 * go; nothing here sends a turn (the kit composer puts them in its field and
 * the person presses Send).
 *
 * React-generic: it imports React only, never the DOM and never react-native,
 * so the web kit (`./react`) and the native arm (`./native`) share this one
 * implementation, the way they share `useTranscript`. The engines are
 * injected: `webSpeechRecognizer()` from `./react`, `expoSpeechRecognizer()`
 * from `./native-adapters`, or a host's own.
 *
 * Decided behaviour:
 *
 * - Interim results are on: every result reports the WHOLE session's text so
 *   far, and `final: true` arrives once, when the session ends (its text is
 *   the finals with any last interim joined on, so the words the person saw
 *   are the words kept).
 * - One generation per session. Events of an ended or aborted session are
 *   dropped, so no late result lands after a send, and a slow result from the
 *   previous session never lands in a new one.
 * - `stop()` (the toggle, the maximum duration) keeps listening for the last
 *   result: start and toggle are no-ops while stopping, a result of the same
 *   session still updates the text, and `final: true` arrives at the engine's
 *   end. `abort()` drops at once and reports no final.
 * - Leaving the screen ends the session: unmount always aborts, and so does
 *   `subscribeBackground`'s callback (an RN host feeds it from AppState; the
 *   web engine aborts on a hidden page itself).
 * - A synchronous throw from the engine's `start` is `error: other`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INITIAL_SPEECH_INPUT_STATE,
  speechInputReducer,
  speechSessionLive,
  speechSessionText,
  type SpeechInputAction,
  type SpeechInputState,
  type SpeechRecognizer,
  type SpeechRecognizerEvent,
  type SpeechSession,
} from "../speech-input.js";

/** One report of a session's text. */
export interface SpeechTranscript {
  /** Every final segment of the session so far, joined. */
  finalText: string;
  /** The segment still being recognized ("" when none). */
  interim: string;
  /** True exactly once per session, when it ended on its own or after `stop()`: this is its text. */
  final: boolean;
}

/** The options of {@link useSpeechInput}. */
export interface UseSpeechInputOptions {
  /** The engine; `null` (or one that is not available here) means the `unsupported` phase. */
  recognizer: SpeechRecognizer | null;
  /** The recognition language (BCP 47), separate from the UI locale. Unset leaves the engine's default. */
  lang?: string;
  /** The session cap: the session STOPS (its words kept) after this long. Default 60 000. */
  maxDurationMs?: number;
  /** How long the "didn't catch that" phase stays before idle. Default 3 000. */
  noMatchMs?: number;
  /**
   * Called once with a callback the host fires when the app leaves the
   * foreground; it returns the unsubscribe. The callback aborts the live
   * session. An RN host feeds it from `AppState` (this hook cannot import
   * react-native).
   */
  subscribeBackground?: (onBackground: () => void) => () => void;
  /** Receives the session's text, whole-session each time, in order. */
  onTranscript?: (transcript: SpeechTranscript) => void;
}

/** What {@link useSpeechInput} returns. */
export interface UseSpeechInputResult {
  state: SpeechInputState;
  /** Whether the engine is available here; false draws no mic. */
  supported: boolean;
  /** A session is live: starting, listening or stopping. */
  listening: boolean;
  /** Begin a session (a no-op while one is live or when unsupported). */
  start(): void;
  /** Finish the live session; its last result still lands. */
  stop(): void;
  /** End the live session at once; nothing it sends later lands. */
  abort(): void;
  /** Start when idle, stop while starting or listening, nothing while stopping. */
  toggle(): void;
}

const UNSUPPORTED: SpeechInputState = { phase: "unsupported" };

export function useSpeechInput(options: UseSpeechInputOptions): UseSpeechInputResult {
  const { recognizer, lang, maxDurationMs = 60_000, noMatchMs = 3_000, subscribeBackground, onTranscript } = options;
  const supported = recognizer !== null && recognizer.isAvailable();

  // Every callback below is created once and reads the live options here.
  const optsRef = useRef({ recognizer, lang, maxDurationMs, noMatchMs, onTranscript, supported });
  optsRef.current = { recognizer, lang, maxDurationMs, noMatchMs, onTranscript, supported };

  const [state, setState] = useState<SpeechInputState>(INITIAL_SPEECH_INPUT_STATE);
  const stateRef = useRef<SpeechInputState>(INITIAL_SPEECH_INPUT_STATE);
  const generationRef = useRef(0);
  const sessionRef = useRef<SpeechSession | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noMatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);

  const clearMaxTimer = useCallback((): void => {
    if (maxTimerRef.current !== null) clearTimeout(maxTimerRef.current);
    maxTimerRef.current = null;
  }, []);
  const clearNoMatchTimer = useCallback((): void => {
    if (noMatchTimerRef.current !== null) clearTimeout(noMatchTimerRef.current);
    noMatchTimerRef.current = null;
  }, []);

  /** Run one action through the reducer, then its effects. Returns whether the state changed. */
  const apply = useCallback(
    (action: SpeechInputAction): boolean => {
      const prev = stateRef.current;
      const next = speechInputReducer(prev, action);
      if (next === prev) return false;
      stateRef.current = next;
      if (mountedRef.current) setState(next);
      const report = optsRef.current.onTranscript;
      if (speechSessionLive(prev) && !speechSessionLive(next)) {
        // The session is over: its timer and handle go with it.
        clearMaxTimer();
        sessionRef.current = null;
        const dropped =
          action.type === "abort" ||
          (action.type === "engine" && action.event.type === "error" && action.event.code === "aborted");
        if (!dropped && (prev.phase === "listening" || prev.phase === "stopping")) {
          report?.({ finalText: speechSessionText(prev), interim: "", final: true });
        }
      } else if (
        action.type === "engine" &&
        action.event.type === "result" &&
        (next.phase === "listening" || next.phase === "stopping")
      ) {
        report?.({ finalText: next.finalText, interim: next.interim, final: false });
      }
      if (next.phase === "no-match") {
        clearNoMatchTimer();
        const generation = next.generation;
        noMatchTimerRef.current = setTimeout(() => {
          noMatchTimerRef.current = null;
          apply({ type: "no-match-expired", generation });
        }, optsRef.current.noMatchMs);
      }
      return true;
    },
    [clearMaxTimer, clearNoMatchTimer],
  );

  const stopGeneration = useCallback(
    (generation: number): void => {
      const s = stateRef.current;
      if ((s.phase !== "starting" && s.phase !== "listening") || s.generation !== generation) return;
      const session = sessionRef.current;
      apply({ type: "stop", generation });
      clearMaxTimer();
      session?.stop();
    },
    [apply, clearMaxTimer],
  );

  const start = useCallback((): void => {
    const { recognizer: engine, lang: language, maxDurationMs: cap, supported: available } = optsRef.current;
    if (!available || engine === null) return;
    const generation = generationRef.current + 1;
    if (!apply({ type: "start", generation })) return;
    generationRef.current = generation;
    clearNoMatchTimer();
    const onEvent = (event: SpeechRecognizerEvent): void => {
      if (!mountedRef.current) return;
      apply({ type: "engine", generation, event });
    };
    let session: SpeechSession;
    try {
      session = engine.start({ ...(language !== undefined ? { lang: language } : {}), onEvent });
    } catch {
      // The engine refused to begin (a Web Speech InvalidStateError, a
      // native module that threw): this session is over as an error.
      apply({ type: "engine", generation, event: { type: "error", code: "other" } });
      return;
    }
    // The engine may already have ended the session synchronously.
    const now = stateRef.current;
    if (!speechSessionLive(now) || now.generation !== generation) return;
    sessionRef.current = session;
    maxTimerRef.current = setTimeout(() => {
      maxTimerRef.current = null;
      stopGeneration(generation);
    }, cap);
  }, [apply, clearNoMatchTimer, stopGeneration]);

  const stop = useCallback((): void => {
    const s = stateRef.current;
    if (s.phase === "starting" || s.phase === "listening") stopGeneration(s.generation);
  }, [stopGeneration]);

  const abort = useCallback((): void => {
    const s = stateRef.current;
    if (!speechSessionLive(s)) return;
    const session = sessionRef.current;
    apply({ type: "abort", generation: s.generation });
    session?.abort();
  }, [apply]);

  const toggle = useCallback((): void => {
    const s = stateRef.current;
    if (s.phase === "starting" || s.phase === "listening") stop();
    else if (!speechSessionLive(s)) start();
  }, [start, stop]);

  // Unmount always aborts; nothing the engine sends afterwards lands.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      clearMaxTimer();
      clearNoMatchTimer();
      if (speechSessionLive(stateRef.current)) stateRef.current = INITIAL_SPEECH_INPUT_STATE;
      session?.abort();
    };
  }, [clearMaxTimer, clearNoMatchTimer]);

  // Leaving the foreground (the host's signal) aborts.
  useEffect(() => {
    if (subscribeBackground === undefined) return;
    return subscribeBackground(abort);
  }, [subscribeBackground, abort]);

  // An engine that stops being available mid-session takes the session with it.
  useEffect(() => {
    if (!supported) abort();
  }, [supported, abort]);

  const exposed = supported ? state : UNSUPPORTED;
  return useMemo(
    () => ({ state: exposed, supported, listening: speechSessionLive(exposed), start, stop, abort, toggle }),
    [exposed, supported, start, stop, abort, toggle],
  );
}
