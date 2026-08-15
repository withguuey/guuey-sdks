/**
 * The ONE place every user-facing string lives — the i18n seam (spec §4.2).
 *
 * Builders override any string (or all of them, for a locale) through
 * `TranscriptPolicy.strings` without forking components; nothing else in the
 * package carries literal copy. Parameterized strings are functions so word
 * order stays translatable ("Ran 4 tools" vs "4 Werkzeuge ausgeführt").
 *
 * The en defaults below are the founder-review copy from the wave-3a design
 * (§4.2 + per-row labels; guuey#135 — F7 keeps them wordsmith-able until 3b
 * freezes the voice).
 */
export interface ChatStrings {
  /** R12 escalation ladder (spec §4.2). */
  connecting: string;
  starting: string;
  longStart: string;
  thinking: string;
  usingTool: (toolTitle: string) => string;
  /** R1 aborted-partial marker + §4.2 aborted line. */
  stopped: string;

  /** R11 family copy — each is a PREFIX slot for the builder's own wording. */
  errorAuth: string;
  errorQuota: string;
  errorTransient: string;
  errorInvalid: string;

  /** R3/R4. */
  toolGroup: (count: number) => string;
  toolGroupFailures: (count: number) => string;
  toolDidntFinish: string;
  /** R4 calm attribution chrome on a display-bearing call ("via {tool}"). */
  viaTool: (toolTitle: string) => string;

  /** R2. */
  reasoningLabel: string;

  /** R9. */
  citations: (count: number) => string;

  /** R15 — the trust invariant's label. */
  unknownLabel: string;

  /** R14. */
  compaction: string;

  /** R0. */
  userCouldntSend: string;
  userRetry: string;

  /** R6 states. */
  viewNegotiating: string;
  viewBootFailure: string;
  viewInlineFallback: string;
  viewExpired: string;
  viewSandboxUnavailable: string;

  /** #192 debug-preset marker (calm never shows it — spec §3, F10). */
  recoveredFromHistory: string;

  /** R5 empty result. */
  noOutput: string;
  /** R5/R15 byte-count note. */
  bytes: (byteCount: number) => string;

  /** R13 states. */
  historyLoading: string;
  threadGone: string;

  /** Renderer chrome (spec §3.2 — the 3b kit's own affordances). */
  jumpToLatest: string;
  showEarlier: (count: number) => string;
  copy: string;
  copied: string;

  /** The 3c composer (`<GuueyChat>`). */
  composerPlaceholder: string;
  composerUnavailable: string;
  composerLabel: string;
  send: string;
  stop: string;
}

/** Humanize a wire tool name: `render_weather-card` → `render weather card`. */
export function humanizeToolName(wireName: string): string {
  return wireName.replace(/[_-]+/g, " ").trim();
}

export const defaultChatStrings: ChatStrings = {
  connecting: "Connecting…",
  starting: "Starting your agent…",
  longStart: "Starting your agent… first load can take a minute",
  thinking: "Thinking…",
  usingTool: (toolTitle) => `Using ${toolTitle}…`,
  stopped: "Stopped.",

  errorAuth: "Sign in to continue.",
  errorQuota: "This agent is over its usage limit.",
  errorTransient: "Something went wrong on our side — try again.",
  errorInvalid: "The app sent a request the agent couldn't read.",

  toolGroup: (count) => `Ran ${count} tools`,
  toolGroupFailures: (count) => (count === 1 ? "1 failed" : `${count} failed`),
  toolDidntFinish: "didn't finish",
  viaTool: (toolTitle) => `via ${toolTitle}`,

  reasoningLabel: "Thought for a moment",

  citations: (count) => (count === 1 ? "1 source" : `${count} sources`),

  unknownLabel: "Unrecognized content",

  compaction: "Earlier conversation summarized",

  userCouldntSend: "Couldn't send",
  userRetry: "Retry",

  viewNegotiating: "Loading view…",
  viewBootFailure: "This view couldn't start",
  viewInlineFallback: "Showing plain content",
  viewExpired: "This view expired",
  viewSandboxUnavailable: "Interactive view unavailable",

  recoveredFromHistory: "recovered from history",

  noOutput: "no output",
  bytes: (byteCount) =>
    byteCount >= 1024 ? `${Math.round(byteCount / 1024)} KB` : `${byteCount} B`,

  historyLoading: "Loading conversation…",
  threadGone: "This conversation is no longer available.",

  jumpToLatest: "Jump to latest",
  showEarlier: (count) => `Show ${count} earlier`,
  copy: "Copy",
  copied: "Copied",

  composerPlaceholder: "Message the agent…",
  composerUnavailable: "Chat is unavailable.",
  composerLabel: "Message",
  send: "Send",
  stop: "Stop",
};
