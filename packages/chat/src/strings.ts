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
  /**
   * R11, code THREAD_HISTORY_UNAVAILABLE (guuey#417): the hydration
   * guard's honest face — the old conversation could not be restored
   * (identity moved / thread gone) and a FRESH session is already
   * composed. Calm and forward-looking, never the failure banner: the
   * generic transient copy on this code made two distinct causes wear one
   * scary face and mis-attributed incident triage.
   */
  errorHistoryUnavailable: string;

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
  /**
   * R0 directive collapse (guuey#422): the calm label for a forwarded
   * view-directive turn — the wire-verbatim text sits behind the expand.
   */
  directiveContinuation: string;

  /** R6 states. */
  viewNegotiating: string;
  viewBootFailure: string;
  viewInlineFallback: string;
  viewExpired: string;
  viewSandboxUnavailable: string;
  /**
   * R6 no-handshake with a CSP diagnosis (guuey#235): the embedding page's
   * own policy blocked the view. Receives the structured verdict so a
   * locale can shape the sentence; the en default names the blocked URI
   * and the exact allowance to add.
   */
  viewCspBlocked: (diagnosis: {
    blockedUri: string;
    violatedDirective: string;
    suggestedEntry: string;
  }) => string;
  /** guuey#204: the chip text for a mount promoted to a host stage/canvas. */
  viewPromoted: (title: string) => string;
  /** guuey#301 chips presentation: an unselected, mountable view's chip text. */
  viewChip: (title: string) => string;
  /** guuey#301 chips presentation: an expired/dead view's chip text (honest state). */
  viewChipExpired: (title: string) => string;
  /** Chip title when the mount has no producing-call title (history cards). */
  viewRefFallbackTitle: string;

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

  /** R10 hitl actions (spec draft.2) — mode buttons use the ASKER's labels. */
  promptAccept: string;
  promptDecline: string;
  promptDismissed: string;
  /** The answered record line, e.g. `Allowed — Always`. */
  promptAnsweredWith: (modeLabel: string) => string;
  promptDeclinedRecord: string;
  /**
   * The OAuth arm (guuey#178): the dismiss action ("Not now" — nothing is
   * written, the ask re-emits next turn), the answered record (the user was
   * sent to the provider), and the return notices the surface shows after
   * the broker 302s back with `?connected=<serverName>` / `?error=<reason>`.
   */
  promptNotNow: string;
  promptOAuthSent: (modeLabel: string) => string;
  oauthConnected: (serverName: string) => string;
  oauthFailed: (reason: string) => string;

  /** R16 — the notice row's label (provenance shows only under debug). */
  noticeLabel: string;

  /**
   * The `ui/open-link` disclosure affordance (guuey#522): a card asked to
   * open a URL — the kit shows WHERE before anything navigates, and the
   * human's own click on `linkOpen` is the only door out.
   */
  linkAskLabel: (host: string) => string;
  linkOpen: string;
  linkDismiss: string;

  /**
   * The forget-this-device affordance (guuey#526): the quiet clear
   * control and its two-tap confirm face.
   */
  clearConversationLabel: string;
  clearConversationConfirm: string;

  /**
   * The suggestion-chip row's accessible name (guuey#533) — the chips
   * themselves are declared content (the app's own words), never kit copy.
   */
  suggestionsLabel: string;

  /** The 3c composer (`<GuueyChat>`). */
  composerPlaceholder: string;
  composerUnavailable: string;
  composerLabel: string;
  send: string;
  stop: string;
}

/** Humanize a wire tool name: `render_weather-card` → `render weather card`. */
/**
 * The ggui generative-UI rail's tool vocabulary, in end-user words
 * (guuey#307): raw wire names ("mcp ggui ggui handshake") read as
 * internals on every card-bearing conversation — and the rail is the
 * platform default (mcp.ggui.ai), so the kit owns its voice the same
 * way it owns the card machinery.
 */
const GGUI_RAIL_TITLES: Record<string, string> = {
  ggui_handshake: "Preparing interactive card",
  ggui_render: "Rendering card",
  ggui_consume: "Updating interactive card",
  ggui_update: "Updating card",
};

export function humanizeToolName(wireName: string): string {
  // MCP wire shape: `mcp__<server>__<tool>` (double-underscore separators).
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(wireName);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server === "ggui" && GGUI_RAIL_TITLES[tool]) return GGUI_RAIL_TITLES[tool];
    const prettyServer = server.charAt(0).toUpperCase() + server.slice(1).replace(/[_-]+/g, " ");
    const prettyTool = tool.replace(/[_-]+/g, " ").trim();
    return `${prettyServer} · ${prettyTool}`;
  }
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
  errorHistoryUnavailable: "This conversation belonged to a previous session — starting fresh.",
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
  directiveContinuation: "Continuing from your action…",

  viewNegotiating: "Loading view…",
  viewBootFailure: "This view couldn't start",
  viewInlineFallback: "Showing plain content",
  viewExpired: "This view expired",
  viewSandboxUnavailable: "Interactive view unavailable",
  viewCspBlocked: (d) =>
    `This page's Content-Security-Policy blocks ${d.blockedUri} — add "${d.violatedDirective} ${d.suggestedEntry}" to the policy so the view can start`,
  viewPromoted: (title) => `${title} — on canvas`,
  viewChip: (title) => title,
  viewChipExpired: (title) => `${title} — expired`,
  viewRefFallbackTitle: "Card",

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

  promptAccept: "Allow",
  promptDecline: "Don't allow",
  promptDismissed: "Dismissed",
  promptAnsweredWith: (modeLabel) => `Allowed — ${modeLabel}`,
  promptDeclinedRecord: "Not allowed",
  promptNotNow: "Not now",
  promptOAuthSent: (modeLabel) => `Connecting — ${modeLabel}`,
  oauthConnected: (serverName) => `Connected ${serverName}. The agent can use it from your next message.`,
  oauthFailed: (reason) => `Couldn't connect: ${reason}`,

  noticeLabel: "Note",

  linkAskLabel: (host) => `This card wants to open ${host}`,
  linkOpen: "Open",
  linkDismiss: "Dismiss",

  clearConversationLabel: "Clear conversation",
  suggestionsLabel: "Suggestions",
  clearConversationConfirm: "Tap again to clear this device",

  composerPlaceholder: "Message the agent…",
  composerUnavailable: "Chat is unavailable.",
  composerLabel: "Message",
  send: "Send",
  stop: "Stop",
};
