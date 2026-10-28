/**
 * The ONE place every user-facing string lives — the i18n seam (spec §4.2).
 *
 * Builders override any string (or all of them, for a locale) through
 * `TranscriptPolicy.strings` without forking components; nothing else in the
 * package carries literal copy. Parameterized strings are functions so word
 * order stays translatable ("Ran 4 tools" vs "4 Werkzeuge ausgeführt").
 *
 * The en defaults below are the reviewed copy from the wave-3a design
 * (§4.2 + per-row labels; guuey#135 — F7 keeps them wordsmith-able until 3b
 * freezes the voice).
 */
import type { PreGenerationRefusal } from "@guuey/mcp-apps-host";
import { isGguiProtocolTool } from "./listen.js";

export interface ChatStrings {
  /** R12 escalation ladder (spec §4.2). */
  connecting: string;
  starting: string;
  longStart: string;
  thinking: string;
  usingTool: (toolTitle: string) => string;
  /**
   * guuey#1279 — the status while a ggui PROTOCOL tool is in flight
   * (handshake/render/consume). The status line never names a rail tool:
   * `usingTool` would read "Using Rendering card…" at best and "Using ggui
   * render…" at worst, so the protocol case gets its own product sentence
   * instead of narrating the lifecycle.
   */
  preparingCard: string;
  /**
   * guuey#2604: the status while the transport waits to send the turn again
   * because every concurrent-turn slot on the agent is taken (`POD_SATURATED`,
   * the saturation retry). `attempt` is the try that was refused (1-based) and
   * `totalAttempts` the whole budget. Replaces the connecting ladder for the
   * wait, so the reader sees why nothing is happening yet. guuey#2608:
   * `secondsLeft` is the countdown to the next try when the renderer keeps
   * one (absent, or 0 once that try is under way).
   */
  saturationRetrying: (attempt: number, totalAttempts: number, secondsLeft?: number) => string;
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
  /**
   * R11, code CONTENT_BLOCKED: the model's safety filter withheld the reply.
   * Not the platform's fault and not the visitor's, so never the transient
   * "our side" banner. Names no provider and no reason.
   */
  errorContentBlocked: string;
  /**
   * R11, code NO_REPLY: the model stopped before it wrote a reply (an
   * output-token stop, a conversation past its context window, a malformed
   * tool call). Not the platform's fault, so never the "our side" banner;
   * names no provider and no reason. It keeps the transient family's Retry,
   * and also points at a new conversation, for the case a retry cannot fix.
   */
  errorNoReply: string;
  /**
   * R11, code ATTACHMENTS_UNSUPPORTED (guuey#2293): the agent's runtime did
   * not acknowledge the turn's images, so the turn was stopped before any
   * reply. Says what to do instead; a retry with the image would meet the
   * same runtime.
   */
  errorAttachmentsUnsupported: string;
  /**
   * R11, code ATTACHMENTS_INVALID (guuey#2293): the send's images broke the
   * V1 rules and nothing was sent. The kit's own composer judges each file
   * first, so this reads on a host that called `send` itself.
   */
  errorAttachmentsInvalid: string;
  /**
   * R11, code INPUT_KIND_NOT_DECLARED (guuey#2549): a turn without words
   * reached an agent that no longer takes one. Nothing was answered; the same
   * turn with a few words works. Equal to the runtime's own reader line.
   */
  errorInputKindNotDeclared: string;
  /**
   * R11, code INPUT_KIND_NOT_ADVERTISED (guuey#2549): the agent's runtime
   * refused a turn without words before it started (the agent does not take
   * one here, or not yet). Nothing was stored; the same turn with a few words
   * works.
   */
  errorInputKindNotAdvertised: string;
  /**
   * R11, code WORKER_POD_RESOURCE_EXHAUSTED: the turn hit a temporary
   * capacity limit and was stopped safely. Transient, so it keeps the
   * transient family's Retry; names nothing internal.
   */
  errorResourceExhausted: string;
  /**
   * R11, code POD_SATURATED (guuey#2604): every concurrent-turn slot on the
   * agent was still taken after the retries. A plain "try again" line, the
   * same sentence guuey's own widget shows; it keeps the transient family's
   * Retry. Never the pod's own envelope, which names a turn cap and a retry
   * delay the reader has no use for.
   */
  errorPodSaturated: string;
  /**
   * R11, code DRAINING: the agent's pod is restarting and the turn was refused
   * before it began. A plain "try again" line, the landing chat's sentence.
   * Never the pod's own envelope, which names a pod and its re-routing.
   */
  errorDraining: string;
  /**
   * R11, code WAKE_TIMED_OUT (guuey#2453, a client code): the app was asleep
   * and did not wake within the wake budget. Nothing is broken, so the error
   * item wears the retry tone and keeps its in-place Retry. Never the bare
   * `agent responded 503` the refusal carried.
   */
  errorWakeTimedOut: string;

  /** R3/R4. */
  toolGroup: (count: number) => string;
  toolGroupFailures: (count: number) => string;
  toolDidntFinish: string;
  /** R4 calm attribution chrome on a display-bearing call ("via {tool}"). */
  viaTool: (toolTitle: string) => string;
  /**
   * guuey#836 — the face of a ggui_render PRE-GENERATION refusal. The
   * envelope's own `message` and `fix` are shown verbatim (ggui authored
   * them for exactly this reader); these two are the chrome around them:
   * the row label, and the retry class as a short hint.
   */
  renderRefused: string;
  renderRefusedRetry: (retry: PreGenerationRefusal["retry"]) => string;

  /** R2. */
  reasoningLabel: string;

  /** R9. */
  citations: (count: number) => string;

  /** R15 — the trust invariant's label. */
  unknownLabel: string;

  /** R14. */
  compaction: string;

  /**
   * R0. `userCouldntSend` is the failed bubble's line when the refusal has no
   * sentence of its own (a code-less failure, or a code with only the generic
   * transient voice); a coded refusal's line is the plan's `failureLine`.
   */
  userCouldntSend: string;
  userRetry: string;
  /**
   * R0 directive collapse (guuey#422): the calm label for a forwarded
   * view-directive turn that carries no tapped words. Since guuey#2031 it is a
   * static line on visitor surfaces (no expand); a merged row draws it in the
   * position of each tap that had no words. The words are the copy owners' to change.
   */
  directiveContinuation: string;
  /**
   * R0b action turn (guuey#2031): the visually hidden prefix read before a
   * tapped control's words, so a screen reader hears the turn was a tap, not
   * typed speech. The words are the copy owners' to change.
   */
  tappedLabelPrefix: string;
  /**
   * R0 (guuey#2549): the line a user turn sent WITHOUT words draws in place of
   * an empty bubble; its content rode on the page the app sent with it (a
   * photo the app uploaded, say). A host whose page carries one thing names it
   * ("Sent a photo"). The words are the copy owners' to change.
   */
  contextOnlyTurn: string;
  /**
   * The debug preset's toggle below an action turn (guuey#2031) that reveals
   * the wire-verbatim directive. Builder surfaces only; never drawn for a
   * visitor.
   */
  directiveRawToggle: string;

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

  /**
   * R7 chips (guuey#2369): the action that opens an https media URL the
   * kit does not load, and the notes on media it will not show inline.
   */
  mediaOpenLink: string;
  mediaOversized: string;
  mediaRefused: string;

  /** R13 states. */
  historyLoading: string;
  threadGone: string;
  /** guuey#2858: the history read stopped at its page cap, so the oldest messages are left out. */
  historyTruncated: string;

  /** Renderer chrome (spec §3.2 — the 3b kit's own affordances). */
  jumpToLatest: string;
  showEarlier: (count: number) => string;
  copy: string;
  copied: string;
  /** guuey#2367 — a tool result whose preview was cut opens to its whole text. */
  showAll: string;
  showLess: string;

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
  /**
   * guuey#2834: the return notice for a reason the broker sends when nothing
   * was decided (`OAUTH_RETRY_ERRORS`: it could not finish the check just
   * now). Names no code; the user only needs to try again.
   */
  oauthRetryLater: string;

  /**
   * The `authMode:'upfront'` connect-first framing (guuey#605): the agent
   * cannot answer at all until these accounts are connected, so the card
   * reads as a step and the composer says why it is holding.
   * `authRequiredHeading` takes the servers' labels already joined for
   * display; `composerAuthRequired` is the held composer's placeholder.
   */
  authRequiredHeading: (serverLabels: string) => string;
  authRequiredHint: string;
  composerAuthRequired: string;

  /**
   * An ask nothing in this chat can answer (guuey#1860): an agent framework's
   * own approval or credential request, with no answer door yet. The card shows
   * the ask and this line, and no actions.
   */
  promptNoAnswerChannel: string;

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

  /**
   * The header slot's close control (guuey#1150) — its accessible name;
   * the visible face is a glyph. The title and any other controls in the
   * row are the host's own content, never kit copy.
   */
  headerClose: string;

  /** The 3c composer (`<GuueyChat>`). */
  composerPlaceholder: string;
  composerUnavailable: string;
  composerLabel: string;
  /**
   * guuey#1038 — the composer's placeholder while the agent LISTENS on a card
   * (ggui's `ggui_consume`): a turn waiting on the user, so the composer stays
   * open and says so. A reply ends the listen and sends.
   */
  composerWaitingOnYou: string;
  /**
   * guuey#2355 — the agent ended this conversation. The banner's heading
   * (the agent's own message is shown beneath it, verbatim), its control
   * that opens a new conversation, and the held composer's placeholder.
   */
  threadClosedTitle: string;
  threadClosedStartNew: string;
  composerThreadClosed: string;
  send: string;
  stop: string;
  /**
   * guuey#2293 — the composer's image affordance (`<GuueyChat attachments>`):
   * the attach button's accessible name, the preview row's label, each
   * preview's Remove button, the status line naming a file the composer did
   * not take, and the turn's input when images are sent with no words (the
   * runtime needs a non-empty input; this line is what the model reads beside
   * the images).
   */
  attachImage: string;
  attachmentsLabel: string;
  removeAttachment: (name: string) => string;
  attachmentRefused: (name: string, reason: "unsupported_type" | "too_large" | "too_many" | "unreadable") => string;
  attachmentsOnlyInput: string;
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

/**
 * guuey#1279 — the title a rail tool the kit has NOT learned yet renders as.
 * The rail's vocabulary is machinery; a tool missing from
 * {@link GGUI_RAIL_TITLES} still gets product words, never `ggui_<verb>`.
 */
const GGUI_UNNAMED_RAIL_TITLE = "Preparing interactive card";

/** MCP wire shape: `mcp__<server>__<tool>` (double-underscore separators). */
const MCP_WIRE_NAME = /^mcp__([^_].*?)__(.+)$/;

/** The bare tool behind a wire name: `mcp__ggui__ggui_render` → `ggui_render`. */
function bareToolName(wireName: string): string {
  const mcp = MCP_WIRE_NAME.exec(wireName);
  return mcp ? mcp[2] : wireName;
}

export function humanizeToolName(wireName: string): string {
  // guuey#1279 — protocol FIRST, and keyed on the BARE name, so the wire shape
  // never decides whether chrome reads as product or as machinery. The old
  // order only caught `mcp__ggui__`-prefixed names that were ALSO in the map:
  // bare `ggui_render`, and any rail tool the map had not learned, fell
  // through to the generic humanizer and reached chrome as "ggui render" —
  // the status line said "Using ggui render…". An unmapped rail tool now
  // resolves to product words instead of ever exposing its wire name.
  if (isGguiProtocolTool(wireName)) {
    return GGUI_RAIL_TITLES[bareToolName(wireName)] ?? GGUI_UNNAMED_RAIL_TITLE;
  }
  const mcp = MCP_WIRE_NAME.exec(wireName);
  if (mcp) {
    const [, server, tool] = mcp;
    const prettyServer = server.charAt(0).toUpperCase() + server.slice(1).replace(/[_-]+/g, " ");
    const prettyTool = tool.replace(/[_-]+/g, " ").trim();
    return `${prettyServer} · ${prettyTool}`;
  }
  return wireName.replace(/[_-]+/g, " ").trim();
}

export const defaultChatStrings: ChatStrings = {
  connecting: "Connecting…",
  starting: "Getting ready…",
  longStart: "Still getting ready. The first reply can take a little longer.",
  thinking: "Thinking…",
  usingTool: (toolTitle) => `Using ${toolTitle}…`,
  preparingCard: "Preparing interactive card…",
  saturationRetrying: (attempt, totalAttempts, secondsLeft) =>
    secondsLeft !== undefined && secondsLeft > 0
      ? `Busy right now. Retrying in ${secondsLeft}s (${attempt}/${totalAttempts})…`
      : `Busy right now. Retrying (${attempt}/${totalAttempts})…`,
  stopped: "Stopped.",

  errorAuth: "Sign in to continue.",
  errorQuota: "This agent is over its usage limit.",
  errorTransient: "Something went wrong on our side. Please try again.",
  errorHistoryUnavailable: "This conversation belonged to a previous session. Starting fresh.",
  errorContentBlocked: "A content filter held back this reply. Try asking in a different way.",
  errorNoReply: "The reply didn't come through. Try again, or start a new conversation.",
  errorResourceExhausted:
    "This conversation hit a temporary capacity limit and was stopped safely. Please try again in a moment.",
  errorPodSaturated: "High demand right now. Please try again in a moment.",
  errorDraining: "This agent is restarting. Please try again in a moment.",
  errorWakeTimedOut: "Your agent didn't wake up in time. Try again.",
  errorInvalid: "The app sent a request the agent couldn't read.",
  errorAttachmentsUnsupported: "This agent can't read images yet. Send your message without the image.",
  errorAttachmentsInvalid: "That image can't be sent. Use a JPEG, PNG, GIF or WebP image, up to 4 at a time.",
  errorInputKindNotDeclared: "This agent no longer accepts a turn without text. Send your message with a few words.",
  errorInputKindNotAdvertised: "This agent can't take a turn without words right now. Send it with a few words.",

  toolGroup: (count) => `Ran ${count} tools`,
  toolGroupFailures: (count) => (count === 1 ? "1 failed" : `${count} failed`),
  toolDidntFinish: "didn't finish",
  viaTool: (toolTitle) => `via ${toolTitle}`,
  renderRefused: "Not rendered",
  renderRefusedRetry: (retry) => {
    switch (retry) {
      case "after-fix":
        return "Retry after the fix";
      case "next-period":
        return "Retry next period";
      case "later":
        return "Retry later";
      case "never":
        return "Not retryable";
    }
  },

  reasoningLabel: "Thought for a moment",

  citations: (count) => (count === 1 ? "1 source" : `${count} sources`),

  unknownLabel: "Unrecognized content",

  compaction: "Earlier conversation summarized",

  userCouldntSend: "Couldn't send",
  userRetry: "Retry",
  directiveContinuation: "Continuing from your action…",
  tappedLabelPrefix: "You chose:",
  contextOnlyTurn: "Sent from the page",
  directiveRawToggle: "Directive sent to the agent",

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
  showAll: "Show all",
  showLess: "Show less",
  bytes: (byteCount) =>
    byteCount >= 1024 ? `${Math.round(byteCount / 1024)} KB` : `${byteCount} B`,

  mediaOpenLink: "Open link",
  mediaOversized: "too large to show",
  mediaRefused: "can't be shown here",

  historyLoading: "Loading conversation…",
  threadGone: "This conversation is no longer available.",
  historyTruncated: "Earlier messages aren't shown.",

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
  oauthRetryLater: "We couldn't check this connection just now. Try again in a moment.",

  authRequiredHeading: (serverLabels) => `Connect ${serverLabels} to start`,
  authRequiredHint: "This agent needs the account before it can answer.",
  composerAuthRequired: "Connect the account above to start.",
  promptNoAnswerChannel: "The agent is waiting on this. Reply in the chat to continue.",

  noticeLabel: "Note",

  linkAskLabel: (host) => `This card wants to open ${host}`,
  linkOpen: "Open",
  linkDismiss: "Dismiss",

  clearConversationLabel: "Clear conversation",
  suggestionsLabel: "Suggestions",
  clearConversationConfirm: "Tap again to clear this device",
  headerClose: "Close",

  composerPlaceholder: "Message the agent…",
  composerUnavailable: "Chat is unavailable.",
  composerLabel: "Message",
  composerWaitingOnYou: "The card is waiting for you — use it, or just reply.",
  threadClosedTitle: "This conversation has ended",
  threadClosedStartNew: "Start a new conversation",
  composerThreadClosed: "This conversation has ended. Start a new one to continue.",
  send: "Send",
  stop: "Stop",
  attachImage: "Attach image",
  attachmentsLabel: "Attached images",
  removeAttachment: (name) => `Remove ${name}`,
  attachmentRefused: (name, reason) => {
    switch (reason) {
      case "unsupported_type":
        return `${name} wasn't added: only JPEG, PNG, GIF and WebP images can be sent.`;
      case "too_large":
        return `${name} wasn't added: it's too large to send.`;
      case "too_many":
        return `${name} wasn't added: a message can carry up to 4 images.`;
      case "unreadable":
        return `${name} wasn't added: it couldn't be read.`;
    }
  },
  attachmentsOnlyInput: "See the attached image.",
};
