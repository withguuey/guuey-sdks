/**
 * guuey#2446 — composer dictation, the HEADLESS core: what a platform speech
 * engine must do, the events it reports, and the one pure reducer over a
 * dictation session's phases. React-free and DOM-free (this is the root
 * subpath): the React hook (`useSpeechInput`, at `./react` and `./native`)
 * owns the timers and the engine; the engines themselves are injected
 * (`webSpeechRecognizer` at `./react`, `expoSpeechRecognizer` at
 * `./native-adapters`).
 *
 * Only TEXT ever leaves a session: the engine hears the audio (the browser's
 * or the device's own recognizer), the host decides where the words go, and
 * nothing here sends a turn. The kit composer puts them in its text field
 * and the person presses Send.
 *
 * ## Generations
 *
 * Every session has a generation number, and every action carries one. An
 * event, stop or abort from any generation other than the live session's
 * changes nothing. That is what keeps a late result out of the field:
 *
 * - `abort()` (Send, an edit to the field, unmount, the page going hidden,
 *   the composer's gate closing) ends the session at once, so every later
 *   event of that session is stale;
 * - a slow result from a previous session, arriving after a new `start()`,
 *   carries the old generation and is ignored.
 *
 * `stop()` is different: it asks the engine to finish the current utterance,
 * and the engine's final result for the last sentence arrives AFTER `stop()`
 * and BEFORE `end`. So `stopping` keeps the session's text and still takes
 * that session's results; only `end` (or an error) closes it.
 */

/**
 * What a platform speech engine must do. The Web Speech API and
 * expo-speech-recognition both fit structurally, through the kit's adapters.
 */
export interface SpeechRecognizer {
  /** Whether the engine exists here (false on Firefox, during SSR, and without the native module). */
  isAvailable(): boolean;
  /**
   * Begin one session. `lang` undefined leaves the engine's own default (the
   * page's `html lang`, or the device's language). An engine may resolve
   * permission asynchronously; `abort()` before its "start" event is legal
   * and starts nothing.
   */
  start(opts: SpeechStartOptions): SpeechSession;
}

/** The options of {@link SpeechRecognizer.start}. */
export interface SpeechStartOptions {
  /** The recognition language (BCP 47), separate from the UI locale. */
  lang?: string;
  /** Receives the session's events, in order. */
  onEvent: (event: SpeechRecognizerEvent) => void;
}

/** One running session of a {@link SpeechRecognizer}. */
export interface SpeechSession {
  /** Finish the current utterance: its final result still arrives, then `end`. */
  stop(): void;
  /** End at once: whatever the engine still reports is dropped. */
  abort(): void;
}

/** What an engine reports during a session. */
export type SpeechRecognizerEvent =
  | { type: "start" }
  /**
   * The WHOLE session's text so far: every final segment joined in
   * `finalText`, plus the current interim segment. Never per segment, so a
   * consumer replaces its text with each result and never appends.
   */
  | { type: "result"; finalText: string; interim: string }
  | { type: "end" }
  | { type: "error"; code: SpeechErrorCode };

/** An engine's error, in the kit's vocabulary (each adapter maps its engine's codes onto these). */
export type SpeechErrorCode =
  | "not-allowed"
  | "no-speech"
  | "audio-capture"
  | "network"
  | "language-not-supported"
  | "aborted"
  | "other";

/** The error codes that end a session in the `error` phase (the rest have their own phases). */
export type SpeechInputErrorCode = Exclude<SpeechErrorCode, "not-allowed" | "no-speech" | "aborted">;

/**
 * A dictation session's phase. `starting`, `listening` and `stopping` are a
 * LIVE session and carry its generation; `no-match` carries the generation
 * whose timer clears it.
 */
export type SpeechInputState =
  /** No engine here; the host draws no mic. */
  | { phase: "unsupported" }
  | { phase: "idle" }
  /** `start()` sent; the engine may still be asking for permission. */
  | { phase: "starting"; generation: number }
  | { phase: "listening"; generation: number; finalText: string; interim: string }
  /**
   * `stop()` sent, waiting for the engine's `end`. start and toggle are
   * no-ops here, and the SAME generation's results still land (the last
   * sentence's final arrives after `stop()`).
   */
  | { phase: "stopping"; generation: number; finalText: string; interim: string }
  /** "Didn't catch that": nothing was heard. Returns to idle when this generation's no-match timer expires. */
  | { phase: "no-match"; generation: number }
  /** The microphone or the recognizer was refused. Sticky until the next `start()`. */
  | { phase: "denied" }
  /** The session ended on an engine error. Stays until the next `start()`. */
  | { phase: "error"; code: SpeechInputErrorCode };

/** The reducer's actions. Each carries the generation it belongs to. */
export type SpeechInputAction =
  /** Begin a session under a NEW generation. */
  | { type: "start"; generation: number }
  /** Finish the live session (the mic toggle, the maximum duration). */
  | { type: "stop"; generation: number }
  /** End the live session at once; its later events are stale. */
  | { type: "abort"; generation: number }
  /** An event the engine reported for the session of `generation`. */
  | { type: "engine"; generation: number; event: SpeechRecognizerEvent }
  /** The no-match line's timer for `generation` ran out. */
  | { type: "no-match-expired"; generation: number };

/** Where a supported recognizer starts. */
export const INITIAL_SPEECH_INPUT_STATE: SpeechInputState = { phase: "idle" };

const IDLE: SpeechInputState = INITIAL_SPEECH_INPUT_STATE;

/** The live-session phases. */
type LiveSpeechState = Extract<SpeechInputState, { phase: "starting" | "listening" | "stopping" }>;

/** True while a session is live: starting, listening or stopping. */
export function speechSessionLive(s: SpeechInputState): s is LiveSpeechState {
  return s.phase === "starting" || s.phase === "listening" || s.phase === "stopping";
}

/** Join two pieces of text with one space, dropping empty ones and the outer whitespace. */
export function joinSpeechText(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (left === "") return right;
  if (right === "") return left;
  return `${left} ${right}`;
}

/** A live session's text as drawn: the finals, then the interim. "" outside listening and stopping. */
export function speechSessionText(s: SpeechInputState): string {
  return s.phase === "listening" || s.phase === "stopping" ? joinSpeechText(s.finalText, s.interim) : "";
}

/**
 * The pure transition. Returns the SAME state object for every action that
 * changes nothing (a stale generation, a start while live, a stop while
 * stopping), so a caller can tell a no-op by identity.
 */
export function speechInputReducer(s: SpeechInputState, a: SpeechInputAction): SpeechInputState {
  if (s.phase === "unsupported") return s;
  switch (a.type) {
    case "start":
      return speechSessionLive(s) ? s : { phase: "starting", generation: a.generation };
    case "stop":
      if ((s.phase !== "starting" && s.phase !== "listening") || s.generation !== a.generation) return s;
      return s.phase === "starting"
        ? { phase: "stopping", generation: s.generation, finalText: "", interim: "" }
        : { phase: "stopping", generation: s.generation, finalText: s.finalText, interim: s.interim };
    case "abort":
      return speechSessionLive(s) && s.generation === a.generation ? IDLE : s;
    case "no-match-expired":
      return s.phase === "no-match" && s.generation === a.generation ? IDLE : s;
    case "engine":
      if (!speechSessionLive(s) || s.generation !== a.generation) return s;
      return engineTransition(s, a.event);
  }
}

function engineTransition(s: LiveSpeechState, e: SpeechRecognizerEvent): SpeechInputState {
  switch (e.type) {
    case "start":
      return s.phase === "starting" ? { phase: "listening", generation: s.generation, finalText: "", interim: "" } : s;
    case "result":
      return {
        phase: s.phase === "stopping" ? "stopping" : "listening",
        generation: s.generation,
        finalText: e.finalText,
        interim: e.interim,
      };
    case "end":
      return IDLE;
    case "error":
      switch (e.code) {
        case "not-allowed":
          return { phase: "denied" };
        case "no-speech":
          // Words already heard are kept: the session ends instead of
          // claiming it heard nothing.
          return speechSessionText(s) !== "" ? IDLE : { phase: "no-match", generation: s.generation };
        case "aborted":
          return IDLE;
        default:
          return { phase: "error", code: e.code };
      }
  }
}
