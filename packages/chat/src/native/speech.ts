/**
 * guuey#2446 — the React Native dictation engine: a {@link SpeechRecognizer}
 * over the device's own recognizer, through an INJECTED speech module of the
 * expo-speech-recognition shape (`ExpoSpeechRecognitionModule`). Exported from
 * `@guuey/chat/native-adapters`; `useSpeechInput` (from `@guuey/chat/native`)
 * takes it as its recognizer, and the host feeds the hook's
 * `subscribeBackground` from AppState.
 *
 * Like every native adapter here, nothing native is imported: the caller
 * passes the module, so this file adds no dependency and no peer and runs
 * anywhere a test can run it. The module needs a development build (it ships
 * native code, so Expo Go cannot load it), plus the app's microphone and
 * speech-recognition usage strings.
 *
 * - `isAvailable()` is the module's `isRecognitionAvailable()`.
 * - `start()` awaits `requestPermissionsAsync()` first: a refusal reports
 *   `not-allowed`; an `abort()` that arrives before the answer starts
 *   nothing and reports nothing; a `stop()` that arrives first starts
 *   nothing and reports `end`.
 * - Then it starts continuous with interim results (`lang` only when given)
 *   and folds each `result` into the whole session's text: a final segment
 *   joins the finals, an interim one replaces the interim.
 * - The module's error codes map onto the kit's; `nomatch` with nothing heard
 *   is `no-speech`. A throw from the module's `start`, or a rejected
 *   permission request, is `other`.
 * - Every listener is removed when the session ends or is aborted, so a
 *   shared module's later events never reach a finished session.
 * - The module is ONE recognizer with ONE event stream, and its events name
 *   no session. So a session that was stopped or aborted while running, or
 *   that reported an error or a `nomatch` (both of which end it for the hook
 *   while the module still owes its `end`), DRAINS first: the next session
 *   (from any recognizer over the same module) subscribes and starts only
 *   after the module's `end` for the previous one, and the previous
 *   session's leftovers (a queued result, `error: aborted`, `end`) reach no
 *   later session. The wait is bounded by
 *   {@link SPEECH_MODULE_END_TIMEOUT_MS}, so a module that never sends that
 *   `end` cannot wedge every later session; a session stopped while running
 *   that never hears its `end` ends at the bound, as a late `end` would.
 *
 * Gap, stated: `ExpoSpeechRecognitionLike` is a structural subset written
 * from expo-speech-recognition's documented API; no copy is installed in this
 * repository. A consumer pins it against the version it installs with a
 * type-only compat check.
 */
import type {
  SpeechErrorCode,
  SpeechRecognizer,
  SpeechRecognizerEvent,
  SpeechSession,
  SpeechStartOptions,
} from "../speech-input.js";

/** The options this adapter passes to the module's `start`. */
export interface ExpoSpeechStartOptions {
  lang?: string;
  interimResults: boolean;
  continuous: boolean;
}

/** The module events this adapter listens to, and their payloads. */
export interface ExpoSpeechEventMap {
  start: null;
  /** One segment: its alternatives, best first. `isFinal` closes the segment. */
  result: { isFinal: boolean; results: ReadonlyArray<{ transcript: string }> };
  error: { error: string; message: string };
  end: null;
  nomatch: null;
}

/** What `addListener` returns. */
export interface ExpoSpeechSubscription {
  remove(): void;
}

/** The slice of `ExpoSpeechRecognitionModule` this adapter drives. */
export interface ExpoSpeechRecognitionLike {
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  start(options: ExpoSpeechStartOptions): void;
  stop(): void;
  abort(): void;
  addListener<K extends keyof ExpoSpeechEventMap>(
    event: K,
    listener: (event: ExpoSpeechEventMap[K]) => void,
  ): ExpoSpeechSubscription;
}

/** The module's error code in the kit's vocabulary; anything unlisted is `other`. */
function errorCode(error: string): SpeechErrorCode {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "no-speech":
    case "speech-timeout":
      return "no-speech";
    case "audio-capture":
    case "network":
    case "language-not-supported":
    case "aborted":
      return error;
    default:
      return "other";
  }
}

/**
 * The longest a new session waits for the module's `end` owed by the previous
 * one. The module sending `end` after `stop()`, `abort()` or an error is its
 * documented behaviour, but it is unverified against an installed
 * expo-speech-recognition; this bound keeps a missing `end` from wedging every
 * later session on that module until the app restarts. Past it the next
 * session starts anyway, and a very late `end` would close that one early: a
 * session the person can start again, not a dead microphone.
 */
export const SPEECH_MODULE_END_TIMEOUT_MS = 3000;

/** One module's pending drain: settles on its next `end`, or at the bound. */
interface ModuleDrain {
  readonly settled: Promise<void>;
  /** Run only when the bound passes with no `end`: each closes a session still waiting for that `end`. */
  readonly onBound: Array<() => void>;
}

/**
 * Per module: the previous session's drain, while a finished session still
 * owes the module's `end`. It settles on the next `end`, or after
 * {@link SPEECH_MODULE_END_TIMEOUT_MS}. Keyed by the module, not the
 * recognizer, because the module is the shared resource: a host that builds
 * a recognizer per render still gets one queue.
 */
const draining = new WeakMap<ExpoSpeechRecognitionLike, ModuleDrain>();

/**
 * Mark the module as owing an `end`; the next session waits for it, or for
 * the bound. Call BEFORE `stop()`/`abort()`, which may emit `end`
 * synchronously, and before forwarding an error or a no-speech, whose
 * handler may start the next session at once. `onBound`, when given, runs
 * if the bound passes with no `end`: a stopped session uses it to end
 * itself, so a module that never answers cannot leave it listening.
 */
function awaitModuleEnd(module: ExpoSpeechRecognitionLike, onBound?: () => void): void {
  const pending = draining.get(module);
  if (pending !== undefined) {
    if (onBound !== undefined) pending.onBound.push(onBound);
    return;
  }
  const callbacks: Array<() => void> = onBound === undefined ? [] : [onBound];
  let settle: (bounded: boolean) => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    let done = false;
    settle = (bounded) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      subscription.remove();
      if (draining.get(module) === drain) draining.delete(module);
      if (bounded) for (const callback of callbacks) callback();
      resolve();
    };
  });
  const timer = setTimeout(() => settle(true), SPEECH_MODULE_END_TIMEOUT_MS);
  const subscription = module.addListener("end", () => settle(false));
  const drain: ModuleDrain = { settled, onBound: callbacks };
  draining.set(module, drain);
}

/** The native engine over an injected expo-speech-recognition module. */
export function expoSpeechRecognizer(module: ExpoSpeechRecognitionLike): SpeechRecognizer {
  return {
    isAvailable: () => module.isRecognitionAvailable(),
    start: (opts: SpeechStartOptions): SpeechSession => {
      /** "pending" until permission answers; "running" once the module started; "closed" after. */
      let phase: "pending" | "running" | "closed" = "pending";
      let subscriptions: ExpoSpeechSubscription[] = [];
      const finals: string[] = [];
      let interim = "";

      const close = (): void => {
        phase = "closed";
        for (const subscription of subscriptions) subscription.remove();
        subscriptions = [];
      };
      const emit = (event: SpeechRecognizerEvent): void => {
        if (phase === "running") opts.onEvent(event);
      };
      const fail = (code: SpeechErrorCode): void => {
        if (phase === "closed") return;
        close();
        opts.onEvent({ type: "error", code });
      };

      const run = (): void => {
        phase = "running";
        subscriptions = [
          module.addListener("start", () => emit({ type: "start" })),
          module.addListener("result", (event) => {
            const text = event.results[0]?.transcript.trim() ?? "";
            if (event.isFinal) {
              if (text !== "") finals.push(text);
              interim = "";
            } else {
              interim = text;
            }
            emit({ type: "result", finalText: finals.join(" "), interim });
          }),
          module.addListener("error", (event) => {
            // An error ends the session while the module still owes its
            // `end`: drain before the error can start the next one, and
            // close first so that `end` and anything after it reach this
            // session no more.
            if (phase === "running") awaitModuleEnd(module);
            fail(errorCode(event.error));
          }),
          module.addListener("nomatch", () => {
            if (finals.length !== 0 || interim !== "") return;
            if (phase === "running") awaitModuleEnd(module);
            fail("no-speech");
          }),
          module.addListener("end", () => {
            emit({ type: "end" });
            close();
          }),
        ];
        try {
          module.start({ ...(opts.lang !== undefined ? { lang: opts.lang } : {}), interimResults: true, continuous: true });
        } catch {
          // The module refused to begin (another session holds the
          // recognizer, or the platform has none): this session is over.
          fail("other");
        }
      };

      /** Run once the module has drained the previous session, unless this one ended while waiting. */
      const runAfterDrain = (): void => {
        const previous = draining.get(module);
        if (previous === undefined) {
          run();
          return;
        }
        void previous.settled.then(() => {
          if (phase === "pending") runAfterDrain();
        });
      };

      module.requestPermissionsAsync().then(
        (permission) => {
          if (phase !== "pending") return;
          if (!permission.granted) fail("not-allowed");
          else runAfterDrain();
        },
        () => fail("other"),
      );

      return {
        stop: () => {
          if (phase === "running") {
            // The module owes an `end` that closes this session. If the
            // bound passes without it, end the session here instead, so its
            // listeners never hear a later session on the same module.
            awaitModuleEnd(module, () => {
              if (phase !== "running") return;
              close();
              opts.onEvent({ type: "end" });
            });
            module.stop();
          } else if (phase === "pending") {
            // Stopped before this session started (permission or the
            // previous session's drain still pending): start nothing, end it.
            close();
            opts.onEvent({ type: "end" });
          }
        },
        abort: () => {
          const wasRunning = phase === "running";
          close();
          if (wasRunning) {
            awaitModuleEnd(module);
            module.abort();
          }
        },
      };
    },
  };
}
