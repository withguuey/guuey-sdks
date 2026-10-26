/**
 * guuey#2446 — the web dictation engine: a {@link SpeechRecognizer} over the
 * browser's Web Speech API (`SpeechRecognition`, else the prefixed
 * `webkitSpeechRecognition`). DOM-only, beside `composer-attachments.ts`;
 * `useSpeechInput` takes it as its injected recognizer, and `<GuueyChat voice>`
 * builds one only when voice is on, so a chat with voice off touches no speech
 * API at all.
 *
 * The audio goes only to the browser's own recognizer, which may be a vendor
 * service (Chrome's is Google's, Edge's Microsoft's, Safari's may be Apple's),
 * which is why voice is off by default and the app's privacy policy names the
 * vendor first. Only text comes back.
 *
 * - `isAvailable()` is false where the API is missing (Firefox) and during
 *   SSR. Nothing is constructed until `start()`.
 * - A session is `continuous` with `interimResults`; `lang` is set only when
 *   given (otherwise the engine uses the page's `html lang`).
 * - Each `result` event folds `event.results` from index 0, so it reports the
 *   whole session's text, never one segment.
 * - Errors map onto the kit's codes; a throw from `start()` (an
 *   InvalidStateError) is `other`.
 * - The page going hidden aborts the session and reports it `aborted`.
 *   After an abort nothing the engine still sends is forwarded.
 */
import type {
  SpeechErrorCode,
  SpeechRecognizer,
  SpeechRecognizerEvent,
  SpeechSession,
  SpeechStartOptions,
} from "../speech-input.js";

/** One recognized segment as the API delivers it (`SpeechRecognitionResult`): its best alternative at index 0. */
export interface WebSpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string } | undefined;
}

/** The session's segments so far (`SpeechRecognitionResultList`). */
export interface WebSpeechResultListLike {
  readonly length: number;
  readonly [index: number]: WebSpeechResultLike | undefined;
}

/** The slice of a `SpeechRecognition` instance this engine drives. */
export interface WebSpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { readonly results: WebSpeechResultListLike }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** The `SpeechRecognition` constructor. */
export type WebSpeechRecognitionConstructor = new () => WebSpeechRecognitionLike;

/** The slice of the page this engine reads: the constructor and the document's visibility. */
export interface WebSpeechWindow {
  SpeechRecognition?: WebSpeechRecognitionConstructor;
  webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
  document?: {
    readonly visibilityState: string;
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
  };
}

/** A Web Speech error string in the kit's vocabulary; anything unlisted is `other`. */
function errorCode(error: string): SpeechErrorCode {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "no-speech":
    case "audio-capture":
    case "network":
    case "language-not-supported":
    case "aborted":
      return error;
    default:
      return "other";
  }
}

/** The whole session's text from a results list: finals joined, then the interim segments joined. */
function foldResults(list: WebSpeechResultListLike): { finalText: string; interim: string } {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const segment = list[i];
    const text = segment?.[0]?.transcript.trim() ?? "";
    if (segment === undefined || text === "") continue;
    (segment.isFinal ? finals : interims).push(text);
  }
  return { finalText: finals.join(" "), interim: interims.join(" ") };
}

/** The web engine. `win` defaults to the page itself. */
export function webSpeechRecognizer(win: WebSpeechWindow = globalThis): SpeechRecognizer {
  const ctor = (): WebSpeechRecognitionConstructor | undefined => win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return {
    isAvailable: () => ctor() !== undefined,
    start: (opts: SpeechStartOptions): SpeechSession => {
      const Recognition = ctor();
      if (Recognition === undefined) {
        opts.onEvent({ type: "error", code: "other" });
        return { stop: () => undefined, abort: () => undefined };
      }
      const rec = new Recognition();
      const document = win.document;
      let open = true;
      const emit = (event: SpeechRecognizerEvent): void => {
        if (open) opts.onEvent(event);
      };
      const close = (): void => {
        open = false;
        document?.removeEventListener("visibilitychange", onVisibility);
      };
      const abort = (): void => {
        if (!open) return;
        close();
        rec.abort();
      };
      function onVisibility(): void {
        if (!open || document?.visibilityState !== "hidden") return;
        abort();
        opts.onEvent({ type: "error", code: "aborted" });
      }
      rec.continuous = true;
      rec.interimResults = true;
      if (opts.lang !== undefined) rec.lang = opts.lang;
      rec.onstart = () => emit({ type: "start" });
      rec.onresult = (event) => emit({ type: "result", ...foldResults(event.results) });
      rec.onerror = (event) => emit({ type: "error", code: errorCode(event.error) });
      rec.onend = () => {
        emit({ type: "end" });
        close();
      };
      document?.addEventListener("visibilitychange", onVisibility);
      try {
        rec.start();
      } catch {
        // `start()` on a recognizer that is already running throws an
        // InvalidStateError: this session never began.
        emit({ type: "error", code: "other" });
        close();
      }
      return {
        stop: () => {
          if (open) rec.stop();
        },
        abort,
      };
    },
  };
}
