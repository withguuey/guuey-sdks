/**
 * `<GuueyChat>` — the batteries-included surface (guuey#135 wave 3c): the
 * whole tier stack wired end to end, PLUS the composer (which arrives here
 * by design — earlier tiers are transcript-only).
 *
 *     useAgentInvoke → useTranscriptInputs → useTranscript → <Transcript>
 *                                                          + the composer
 *
 * It is a THIN composition of the exported tiers — every wire below is a
 * public API, so a builder ejects one level down (own composer around
 * `<Transcript>`, own renderer over `planTranscript`, own everything over
 * `invokeTurn`) without a cliff. Every prop beyond the connection
 * essentials is optional.
 *
 * ## Composer state matrix
 *
 * - `endpointUrl === null` → input disabled, `composerUnavailable`
 *   placeholder (chat cannot exist).
 * - idle (`status === "ready"`) → input enabled; **Send** enabled iff the
 *   input has non-whitespace text.
 * - in flight (any other status, cold-start waits included — R12's status
 *   line owns the WHY) → input stays enabled (type the next message while
 *   the agent works), Send is replaced by **Stop**, which aborts the turn
 *   (partial text kept, "Stopped." marked — the hook's contract).
 * - Enter sends; Shift+Enter inserts a newline; an IME-composing Enter
 *   never sends (the candidate commit is not a submit).
 * - `plan.authRequired !== null` (guuey#605 — an `authMode:'upfront'` OAuth
 *   server is pending connection) → input disabled, `composerAuthRequired`
 *   placeholder, Send gated, and a connect-first line above the composer.
 *   The RUNTIME is the enforcer (it refuses every turn before any model
 *   call); this only stops the user spending a message to learn that.
 *   Dismissing the card releases the gate — no dead end.
 *
 * ## History
 *
 * Thread rehydration is the HOOK's mechanics: give `adapters` a `history`
 * adapter (e.g. `createWebAdapters({ apiBaseUrl, … })`) and a persisted
 * threadId rehydrates on mount — text transcript + persisted cards, which
 * mount through the same R6 path as live views. Nothing here to configure.
 *
 * ## The imperative seam (guuey#210)
 *
 * Suggested-prompt chips and other host-driven sends stay on the
 * batteries-included path via {@link GuueyChatHandle} — a ref handle
 * (`forwardRef`) and/or the `onReady` callback, ONE stable object for the
 * component's whole life. `send` runs through exactly the Send button's
 * gate (never bypasses it; the typed draft is left untouched — a chip send
 * must not eat a half-typed message); `prefill` mirrors the widget's
 * staged-composer semantics (append joins with a space, never clobbers).
 * Web-only for now: the native tier ships `<NativeTranscript>` without a
 * native GuueyChat, so there is no native surface to put a handle on yet.
 */
import { forwardRef, type CSSProperties, type ReactNode, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  createUiActionRelay,
  createUiResourceReader,
  createWebAdapters,
  deleteThread,
  IMAGE_ATTACHMENTS_MAX_COUNT,
  IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS,
  mergeGuestThreads,
  type AgentInvokeAdapters,
  type ImageAttachment,
  type InputKind,
  type SendOptions,
} from "@guuey/agent-client";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import { useAgentInvoke, VIEW_MESSAGE_TURN_CAPABILITIES } from "@guuey/agent-client/react";
import { mountedCardProps, unavailableToolCallResult } from "@guuey/mcp-apps-host";
import type {
  MountedCardProps,
  McpToolCallResult,
  UiActionRequest,
  UiResourceReader,
  UserMessageDelivery,
} from "@guuey/mcp-apps-host";
import { calmPolicy, debugPolicy, type TranscriptPolicyOverrides } from "../policy.js";
import { isWaitingOnUser } from "../listen.js";
import { retryInPlaceArgs } from "../retry.js";
import { useConnectWait } from "./use-connect-wait.js";
import { useStructuralIdentity } from "./structural-identity.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import type {
  ChatDebugEvent,
  ErrorItem,
  PlanViewSummary,
  PromptItem,
  TapWithdrawReason,
  UserMessageItem,
  ViewRefItem,
} from "../types.js";
import { themeCssVars, type ThemeMode } from "./theme-css.js";
import { facesCss, useHostFaces } from "./faces.js";
import { hostContextStyles, hostStyleVariables, type HostStyleVariables } from "../host-style-variables.js";
import { Transcript, type TranscriptWindowing } from "./transcript.js";
import type { TranscriptComponents, TranscriptItemContext, ViewSlotProps } from "./components.js";
import { useTranscript, useTranscriptInputs } from "./use-transcript.js";
import { useTapEcho } from "./use-tap-echo.js";
import type { ClaimedTap } from "../tap-ledger.js";
import { oauthPromptAction, useOAuthReturn } from "./oauth-return.js";
import { oauthReturnNoticeLine, oauthReturnTone } from "../oauth.js";
import { PARTS } from "./parts.js";
import { ATTACHMENT_ACCEPT, readImageFile, type AttachmentRefusalReason } from "./composer-attachments.js";
import { ChatHeader, type GuueyChatHeader } from "./chat-header.js";
import { chatCtaIdFor, createChatAnalytics, type ChatAnalytics, type ChatAnalyticsSetting } from "../analytics.js";

/**
 * The kit-tier theme announce (guuey#302): default `hostContext.theme`
 * from the transcript mode onto every view slot. A caller-declared
 * `hostContext` key wins field-by-field; `theme` is only filled in.
 * Exported for tests; not part of the package surface.
 */
export function viewPropsWithThemeAnnounce(
  viewProps: TranscriptItemContext["viewProps"],
  mode: ThemeMode,
  defaults: Pick<
    ViewSlotProps,
    "onCallTool" | "onUpdateModelContext" | "onUserMessage" | "onOpenLink"
  > = {},
  /** guuey#1195: the theme's `@font-face` CSS — handed to every card as `hostContext.styles.css.fonts`; "" hands nothing. */
  fontsCss = "",
  /** guuey#1128: the theme's palette as spec `--color-*` slots — `hostContext.styles.variables`, ggui's fallback layer beneath the app theme. */
  variables: HostStyleVariables | undefined = undefined,
  /**
   * guuey#2031: the kit relay wrapped by the tap echo. It replaces
   * `defaults.onCallTool` only on a slot that takes BOTH the kit's relay and
   * the kit's `ui/message` sink (no own `onCallTool` key, no own
   * `onUserMessage` key): a tap is drawn only where the kit's own sink will
   * send its doorbell and swap the drawing for the sent row.
   */
  echoOnCallTool: ViewSlotProps["onCallTool"] = undefined,
): TranscriptItemContext["viewProps"] {
  const styles = hostContextStyles(fontsCss, variables);
  const themed = (base: ViewSlotProps | undefined): ViewSlotProps => {
    const echo =
      echoOnCallTool !== undefined &&
      defaults.onCallTool !== undefined &&
      defaults.onUserMessage !== undefined &&
      (base === undefined || (!Object.hasOwn(base, "onCallTool") && !Object.hasOwn(base, "onUserMessage")));
    return {
      // Kit-default host wires (guuey#335): the ACTION RELAY (Confirm inside
      // a rendered card is a tools/call — without a relay the initialize-only
      // host -32601s and the interaction visibly fails) and the
      // model-context sink (a COMPLEMENT channel — producers mirror the
      // snapshot server-side, so a recording sink is honest). A caller-
      // declared slot prop always wins.
      ...defaults,
      ...(echo ? { onCallTool: echoOnCallTool } : {}),
      ...base,
      hostContext: { theme: mode, ...styles, ...base?.hostContext },
    };
  };
  if (typeof viewProps === "function") {
    return (item, mount) => themed(viewProps(item, mount));
  }
  return themed(viewProps);
}

/**
 * The imperative seam (guuey#210): programmatic send/prefill/focus for
 * hosts that stay on the batteries-included path (suggested-prompt chips
 * being the filing use case). Reach it via `ref` or `onReady` — both
 * deliver the SAME stable object, valid for the component's whole life.
 */
/**
 * One turn-lifecycle edge (guuey#403): `submit` = a turn left `ready`;
 * `settled` = the invoke returned to `ready`. Mirrored structurally by
 * `@guuey/agent-layout`'s `GuueyChatActivityEventShape` — keep the two in
 * sync (the fs-contract mirror discipline).
 */
export interface GuueyChatActivityEvent {
  type: "submit" | "settled";
}

export interface GuueyChatHandle {
  /**
   * Send `text` through exactly the Send button's gate: returns `false`
   * and does nothing when chat is unavailable (`endpointUrl === null`), a
   * turn is in flight, or the text is blank — it NEVER bypasses the
   * composer's rules. The typed draft is left untouched (a programmatic
   * send must not eat a half-typed message). Failures surface the same
   * way a composer send's do (the hook's `error` / R0 failed-send).
   *
   * guuey#2549: with `opts.inputKind` and blank `text`, it sends a turn
   * WITHOUT words (its content rides on the page context): only the
   * availability and in-flight gates apply, and the agent's runtime judges
   * the turn (a refusal draws as that turn's failed state). Beside non-blank
   * text the kind is ignored.
   */
  send(text: string, opts?: { inputKind?: InputKind }): boolean;
  /**
   * Put `text` into the composer draft. `append: true` joins onto a
   * non-empty draft with a single space (the widget's staged-composer
   * semantic — never clobbers); default replaces. Focuses the input
   * unless `focus: false`.
   */
  prefill(text: string, opts?: { focus?: boolean; append?: boolean }): void;
  /** Focus the composer input. */
  focusComposer(): void;
  /**
   * The CURRENT persisted thread id, or `null` before the first turn is
   * admitted (it hydrates from storage on mount and from the pod's
   * `session` frame on the first send). Read on demand — a live value, not
   * a mount-time snapshot — so a host can key its own per-thread state
   * without wrapping `adapters.storage`. For a push-style notification use
   * {@link GuueyChatProps.onThread}.
   */
  readonly threadId: string | null;
  /**
   * The input kinds (guuey#2549) the agent offered on its latest turn, or
   * `null` before any turn was admitted: a HINT for whether to offer a send
   * without words (`send("", { inputKind })`). Read on demand, like
   * {@link threadId}; the runtime still judges every turn.
   */
  readonly acceptedInputKinds: readonly InputKind[] | null;
  /**
   * The slot props the kit's OWN inline mounts run with — theme announce,
   * default action relay, model-context sink (guuey#335). A host mounting
   * a roster view on its own canvas (`<GuueyView {...handle.viewSlotProps()}`>)
   * gets the identical wiring, so a rendered card's Confirm works there
   * too. Live values (read on demand); when the host passed a FUNCTION-form
   * `viewProps`, this returns the kit defaults (per-item resolution belongs
   * to the transcript).
   */
  viewSlotProps(): ViewSlotProps;
  /**
   * Forget this conversation (guuey#526 — the public-computer story).
   *
   * Local half, unconditional and immediate: aborts any in-flight turn
   * FIRST (a completing turn can re-persist its own rows), drops the
   * durable thread pointer AND its persisted storage key, wipes the
   * visible transcript, clears the typed draft and any pending link ask —
   * the next send mints a fresh thread.
   *
   * Server half, best-effort: when the surface has a platform door
   * (`apiBaseUrl`) and a minted thread, fires
   * `DELETE /v1/threads/:threadId` with the SAME identity the thread was
   * created under (captured before any rotation) — real, child-first
   * server-side erasure. A denied or failed delete still clears the
   * device (the contract's unlinkability fallback) and surfaces nothing
   * louder than the `thread-delete` debug event.
   *
   * Afterwards `onGuestSecretRotate` fires (when wired), so the identity
   * owner mints a fresh guest secret — even an orphaned server row is
   * unreachable from a rotated identity.
   */
  clearConversation(): void;
  /**
   * Report a visitor interaction with a host-owned input that feeds this
   * chat (a page's own ask bar under `composer={false}`): emits
   * `helper_opened` once per mount under the {@link GuueyChatProps.analytics}
   * opt-in, and does nothing otherwise. The kit composer's own focus and the
   * first visitor turn report themselves.
   */
  markOpened(): void;
}

export interface GuueyChatProps {
  /** Pod base URL (with or without `/agent/invoke`). `null` disables chat. */
  endpointUrl: string | null;
  /**
   * The head row over the conversation (guuey#1150: builders
   * bring their own design through ONE component, not two hand-rolled
   * headers). Rendered as the FIRST child of `.guuey-chat-surface` — inside
   * the theme stamp (#1126), so its `var(--guuey-chat-X, var(--_guuey-chat-X))`
   * reads resolve like every other piece of chrome — as
   * `<header class="guuey-chat-header">` with `guuey-chat-header-title`,
   * `guuey-chat-header-actions` (present only when there is something to
   * put in it) and `guuey-chat-header-close`. Absent → NOTHING is rendered
   * (no wrapper, no placeholder — the default markup is byte-identical to a
   * surface without the slot).
   *
   * The row is {@link ChatHeader}; a host that mounts `<Transcript>` with
   * its own composer (it never mounts `<GuueyChat>`) renders that component
   * directly, so both kinds of surface draw the one row (guuey#1169).
   */
  header?: GuueyChatHeader;
  /** Owning app id — namespaces the persisted threadId. */
  appId?: string;
  /**
   * The agent-mode PIN (guuey#566 — the guest/auth axis), carried on every
   * turn's invoke body exactly as the widget page carries its `guuey:init`
   * `mode`. Carriage only: the pod derives the real mode from the caller's
   * auth state and this only pins WITHIN permission (fail-soft — an unknown
   * key is ignored, never a refusal). Added for guuey#1152: the widget's
   * inline transcript mounts THIS component in the host page, and an embed
   * that pinned a mode must not silently lose it on the way in.
   */
  agentMode?: string;
  /**
   * Whether this chat advertises that a card's `ui/message` becomes the next
   * turn (the view-message-turn capability, beside the default `hitl` set,
   * which it always keeps). Absent, the kit decides: it advertises it
   * whenever it can PROVE its own `ui/message` sink is the one every view slot
   * gets, i.e. `viewProps` is absent or an object that does not carry an
   * `onUserMessage` key at all. That sink sends the message at once when
   * idle, queues it while a turn is live, and answers an undeliverable one as
   * not delivered (logging the drop when the chat is unavailable). A host that
   * passes a function-form `viewProps`, or its own `onUserMessage`, sets this
   * itself: `true` only when its delivery keeps the same promise.
   */
  viewMessageTurns?: boolean;
  /**
   * The guuey public API base (`…/v1`). Enables the batteries-included
   * read paths without hand-wiring: when set and no `adapters` are given,
   * the default `createWebAdapters` gains transcript history; when set and
   * no `reader` is given, a `UiResourceReader` is built over the same
   * identity so generative-UI locators resolve (guuey#221 — a guest kit
   * user has no bearer to construct one with). Explicit `adapters` /
   * `reader` always win. Absent → today's behavior (no history, no
   * default reader; locators render as expired, labeled).
   */
  apiBaseUrl?: string;
  /**
   * Identity for the default adapters + default reader — the same two
   * resolvers `createWebAdapters` takes (bearer wins; guest secret next;
   * neither → cookie identity). Ignored when explicit `adapters` and
   * `reader` are both supplied.
   *
   * Guest → signed in: when a surface that ran as a guest gains
   * `getAccessToken` (with `apiBaseUrl` and `appId` set), the kit moves the
   * guest's threads in this app to the signed-in user (`mergeGuestThreads`,
   * for apps whose sign-in is their own issuer), keeps the same thread, and
   * then calls `onGuestSecretRotate`. A plane without the merge route leaves
   * today's behaviour: the signed-in turn starts its own thread.
   */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  getGuestSecret?: () => string | null;
  /**
   * Host couplings (storage / id / transport / history). Default:
   * `createWebAdapters({ apiBaseUrl, getAccessToken, getGuestSecret })` —
   * localStorage thread persistence + the web SSE transport (cookie/guest
   * identity, saturation + cold-start retries), plus history when
   * `apiBaseUrl` is set. The default's saturation retries show as the
   * `busy` status line (`strings.saturationRetrying`) and its wake waits as
   * the `waking` line (`strings.waking`); a host's own adapters own their
   * retries and pass `connectWait` to the plan themselves (`useConnectWait`)
   * if they want the same lines.
   */
  adapters?: AgentInvokeAdapters;
  /** Policy preset (spec §5). Default `"calm"`. */
  preset?: "calm" | "debug";
  /**
   * Knob overrides applied on top of the preset (spec §3's columns) —
   * per-SECTION partials (`{ view: { presentation: "chips" } }` needs no
   * other view fields; guuey#321 made the type tell the merge's truth).
   */
  policy?: TranscriptPolicyOverrides;
  /** Per-slot component overrides (spec §3's override column). */
  components?: Partial<TranscriptComponents>;
  /** String overrides — merged over the preset's `ChatStrings` (§4.2). */
  strings?: Partial<ChatStrings>;
  theme?: GuueyChatTheme;
  mode?: ThemeMode;
  /**
   * Message-surface presentation (guuey#521). `"card"` (default) keeps
   * assistant text on its own card; `"bare"` sits the transcript directly
   * on the host's background so the embed reads native to the page.
   */
  surface?: "card" | "bare";
  /**
   * Render the built-in composer (default `true`). `false` hides it for
   * hosts that drive the conversation through the imperative handle
   * (guuey#210 `ask`/`compose`) or their own input — pairs with the
   * handle instead of forcing a CSS hide (guuey#521).
   */
  composer?: boolean;
  /**
   * The composer's image affordance (guuey#2293), default `false`. On, the
   * built-in composer carries an attach button (JPEG, PNG, GIF, WebP), takes
   * pasted images, shows each as a preview with its own Remove button, and
   * sends them with the turn (`send(text, { attachments })`). A runtime that
   * does not acknowledge the images ends the turn with
   * `ATTACHMENTS_UNSUPPORTED`, read as `strings.errorAttachmentsUnsupported`.
   * Off, the composer and every body it sends are exactly as before.
   */
  attachments?: boolean;
  /** DOM windowing (§3.2). `false` renders everything. */
  window?: TranscriptWindowing | false;
  /**
   * R6 locator resolution (history cards + meta-less live renders). See
   * `useTranscript`. Defaults from `apiBaseUrl` (+ `endpointUrl` for the
   * pod door) when omitted; an explicit reader always wins.
   */
  reader?: UiResourceReader;
  /**
   * The forget-this-device affordance (guuey#526 — the public-computer
   * story): a quiet "Clear conversation" control with a two-tap confirm,
   * wired to {@link GuueyChatHandle.clearConversation}. Default: ON when
   * the surface runs GUEST identity (`getGuestSecret` present — the
   * seamless principle; a signed-in surface has account-level
   * recourse), OFF otherwise; pass a boolean to override either way.
   */
  clearAffordance?: boolean;
  /**
   * Guest-secret rotation hook (guuey#526): called at the END of every
   * {@link GuueyChatHandle.clearConversation} — after the server delete
   * has been dispatched with the OLD identity — so the owner of the
   * secret's storage (the kit never stores it; `getGuestSecret` is a
   * getter) mints a fresh one. Rotation is what makes even an orphaned
   * server row unreachable: the new identity is a stranger to it. Guest
   * KV state is (user,mcp)-scoped and is orphaned by rotation, by design.
   */
  onGuestSecretRotate?: () => void;
  /**
   * Suggestion chips (guuey#533 — declared content, the one-truth design):
   * rendered on the EMPTY transcript only (they retire the moment a
   * message exists — live send or restored history both count), one tap
   * SENDS the chip text verbatim through exactly the Send button's gate.
   * Default-ON when content exists; `false` opts the surface out. The kit
   * mirrors the card projection's caps render-side (4 shown, ≤80 chars
   * each, blank-rejected) — a direct consumer bypassing the platform's
   * emit gate gets the same bounds. Content is the host's (the widget
   * passes the card's `suggestions`; a direct consumer passes its own);
   * the kit never invents chips — an honest empty state beats invented
   * questions in the builder's voice.
   */
  suggestions?: readonly string[] | false;
  /** The debug sink (spec §5) — fires only under the debug policy. */
  onDebugEvent?: (event: ChatDebugEvent) => void;
  /** R6 pass-through (relay hook, sandbox page/flags, host context…). */
  viewProps?: TranscriptItemContext["viewProps"];
  /**
   * R10: what accept/decline actually DO (the grant channel is the host's).
   * The transcript record moves regardless; without a handler the prompt
   * card is record-only.
   */
  onPromptAction?: (
    item: PromptItem,
    action: "accept" | "decline" | "dismiss" | { grantModeId: string },
  ) => void;
  /**
   * Receives the VALIDATED wire answer for an AgJSON HITL ask (spec
   * draft.2) — the host owns delivering it (the kit has no answer
   * transport). Fired after the transcript record moves.
   */
  onHitlAnswer?: (answer: AgHitlAnswer, ask: AgPausedAsk) => void;
  /**
   * The OAuth "authorize this server" arm (guuey#178): where the broker
   * sends the user back after the provider dance. Defaults to this page's
   * own location (stale return params stripped). Pass a value when the
   * chat lives at a URL that is not where the user should land.
   */
  oauthReturnTo?: string;
  /**
   * How the authorize link is opened. Defaults to `openOAuthAuthorize`
   * (in-place navigation; a new tab when framed). The composite ALSO shows
   * the return notice itself (`useOAuthReturn`) — a host that overrides
   * `open` and lands elsewhere renders its own.
   */
  onOAuthAuthorize?: (href: string, ask: AgPausedAsk) => void;
  /** R11 action slot (sign-in / retry affordances). */
  onErrorAction?: (item: ErrorItem) => void;
  /**
   * Turn-lifecycle notifications (guuey#403 — the agent-layout bridge's
   * seam, though any host may listen): `submit` fires when a turn this
   * surface started leaves `ready` — composer, `handle.send`, and the
   * `ui/message` doorbell paths alike (the busy transition IS the truth:
   * gate-refused sends never fire) — and `settled` when the invoke
   * returns to `ready` (success, error, and abort all settle). Discrete
   * per-turn edges only, NEVER per-token — safe to wire into layout
   * state. `@guuey/agent-layout` mirrors {@link GuueyChatActivityEvent}
   * structurally (its `bind.ts` — sync comment there points here).
   */
  onActivity?: (event: GuueyChatActivityEvent) => void;
  /**
   * Callback route to the {@link GuueyChatHandle} for hosts that prefer
   * wiring over refs. Fires ONCE per component instance, on mount, with
   * the same stable handle the ref receives.
   */
  onReady?: (handle: GuueyChatHandle) => void;
  /**
   * Fires with the thread id when it first hydrates and again whenever it
   * changes to a DIFFERENT id (a new chat, a reset that starts a fresh
   * thread). Never fires for `null`, and never re-fires for the same id
   * across re-renders or StrictMode's remount cycle. Pair with
   * {@link GuueyChatHandle.threadId} for the pull-style read.
   */
  onThread?: (threadId: string) => void;
  /**
   * Usage events for the host's own analytics (default off): `helper_opened`
   * (the first visitor interaction per mount: composer focus,
   * {@link GuueyChatHandle.markOpened}, or the first turn),
   * `helper_message_sent` (each visitor turn as its 1-based number, never its
   * text) and `helper_cta_clicked` (a click on a link the chat renders, as the
   * link's `data-cta`, else its origin + path). Each carries `app_id`,
   * `surface: "inline"` and `gui`; nothing emits without `appId`.
   *
   * `true` captures on the host page's own `window.posthog` when the page has
   * one (the kit initialises nothing and stores nothing, so the page's consent
   * setup governs the events); a function `(event, properties) => void`
   * receives the same calls; `{ capture?, gguiEnabled? }` adds the app's
   * generative-UI switch as its public card reports it (`false` stamps
   * `gui: "off"`, anything else `"on"`). Links inside a card's own sandbox are
   * not observable here and are not counted.
   */
  analytics?: ChatAnalyticsSetting;
  /**
   * guuey#301's host-stage trio (all optional; absent = today's inline
   * behavior). `promotedViewKey` = the mount key the host's stage/canvas
   * currently shows (chips it in the transcript — with
   * `policy.view.presentation: "chips"` EVERY view chips and this key
   * marks the selected one). `onViewRef` fires on chip click — set the
   * key from it for the browser-history mechanic. `onViewsChange`
   * delivers the plan's view roster (key/title/phase/channel/mount) so
   * the host can render the selected mount with `<GuueyView>`.
   */
  promotedViewKey?: string;
  onViewRef?: (item: ViewRefItem) => void;
  onViewsChange?: (views: PlanViewSummary[]) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * Saturation retries the default adapters make after the first refused send
 * (guuey#2604): the widget's end-user budget (guuey#406), so a reader sees
 * "Retrying (1/4)" through "(3/4)" before the busy error.
 */
const SATURATION_RETRIES = 3;

const PROMPT_STATE = {
  accept: "answered",
  decline: "declined",
  dismiss: "dismissed",
} as const;

/**
 * True when the kit's own `ui/message` sink is the one every view slot gets:
 * no `viewProps`, or an object form with no `onUserMessage` KEY. The slot
 * props are the kit's defaults spread UNDER the caller's, so an own
 * `onUserMessage` key replaces the kit's sink even when its value is
 * `undefined` (which leaves the slot with none). A function form resolves
 * per item, so the kit cannot know, and says no.
 * Exported for tests; not part of the package surface.
 */
export function kitSinkInEffect(viewProps: TranscriptItemContext["viewProps"]): boolean {
  if (viewProps === undefined) return true;
  if (typeof viewProps === "function") return false;
  return !Object.hasOwn(viewProps, "onUserMessage");
}

/** guuey#2293 — one image waiting in the composer: its wire shape, its preview and its file name. */
interface PendingImage {
  id: string;
  name: string;
  attachment: ImageAttachment;
  previewUrl: string;
}

/** The send options for a composer turn's images; `undefined` for none (the body is then exactly as before). */
function sendOptionsFor(images: readonly ImageAttachment[]): SendOptions | undefined {
  return images.length > 0 ? { attachments: images } : undefined;
}

/**
 * The send options for a doorbell's turn (guuey#2031), from the ONE entry the
 * echo marked sent for it (`markSent`, called before the send): that entry's
 * id (the one the echo draws it under) and its words, every merged tap's in
 * order. `undefined` when no tap is waiting for it. The hook runs the writer
 * contract on the words.
 */
function tapSendOptions(sent: ClaimedTap | null): SendOptions | undefined {
  return sent === null ? undefined : { clientMessageId: sent.id, tapLabels: sent.labels };
}

export const GuueyChat = forwardRef<GuueyChatHandle, GuueyChatProps>(function GuueyChat(
  props: GuueyChatProps,
  ref,
): ReactNode {
  const {
    endpointUrl,
    header,
    appId,
    agentMode,
    viewMessageTurns: viewMessageTurnsProp,
    apiBaseUrl,
    getAccessToken,
    getGuestSecret,
    adapters: adaptersProp,
    preset = "calm",
    policy: policyOverrides,
    components,
    strings: stringOverrides,
    theme = DEFAULT_CHAT_THEME,
    mode = "light",
    surface = "card",
    composer = true,
    attachments: attachmentsEnabled = false,
    window: windowing,
    reader,
    onDebugEvent,
    viewProps,
    promotedViewKey,
    onViewRef,
    onViewsChange,
    onPromptAction,
    onHitlAnswer,
    oauthReturnTo,
    onOAuthAuthorize,
    onErrorAction,
    clearAffordance,
    onGuestSecretRotate,
    suggestions,
    onActivity,
    onReady,
    onThread,
    analytics: analyticsSetting,
    className,
    style,
  } = props;

  // The usage events (see `GuueyChatProps.analytics`): ONE tracker for the
  // mount, so the opened flag and the turn count survive every re-render; the
  // app id and the setting are read live at emit time.
  const analyticsReadRef = useRef({ appId, setting: analyticsSetting });
  analyticsReadRef.current = { appId, setting: analyticsSetting };
  const analyticsRef = useRef<ChatAnalytics | null>(null);
  if (analyticsRef.current === null) analyticsRef.current = createChatAnalytics(() => analyticsReadRef.current);
  const analytics = analyticsRef.current;

  // Identity stabilization (guuey#303 QA — the template's own chat-rail
  // shipped the failure): hosts pass inline literals and arrows, so prop
  // IDENTITY is noise. The getter props route through refs (presence, not
  // identity, is the re-mint trigger — flipping guest↔bearer is a real
  // change; a fresh arrow per render is not), and the policy/strings
  // overrides stabilize structurally below. Without this, every host
  // re-render re-minted the plan, whose views-emission effect calls the
  // host back → setState → re-render → "Maximum update depth exceeded".
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;
  // The handle is created once ([] deps) but must read the LIVE base —
  // same ref discipline as every other handle-read value in this file.
  const apiBaseUrlRef = useRef(apiBaseUrl);
  apiBaseUrlRef.current = apiBaseUrl;
  const getGuestSecretRef = useRef(getGuestSecret);
  getGuestSecretRef.current = getGuestSecret;
  const onGuestSecretRotateRef = useRef(onGuestSecretRotate);
  onGuestSecretRotateRef.current = onGuestSecretRotate;
  const hasAccessToken = getAccessToken !== undefined;
  const hasGuestSecret = getGuestSecret !== undefined;
  // The guest → signed-in merge reads the LAST guest getter the host gave:
  // a host that signs in usually drops `getGuestSecret` in the same render
  // that adds `getAccessToken`, and the merge must still present the guest.
  const lastGuestGetterRef = useRef(getGuestSecret);
  if (getGuestSecret !== undefined) lastGuestGetterRef.current = getGuestSecret;
  const appIdRef = useRef(appId);
  appIdRef.current = appId;

  // guuey#2604 — the busy notice: the default transport retries a turn the
  // agent refused at its concurrent-turn ceiling (POD_SATURATED) and reports
  // each wait here. The turn stays `connecting` throughout, so the plan reads
  // this beside the status to say "busy, retrying" instead of climbing the
  // connecting ladder. A host's own `adapters` own their transport and their
  // retry, so the notice is the default adapters' only.
  // guuey#2608: counted down from each reported wait, so the line says when.
  // guuey#2453: the same one wait carries the wake (the default transport's
  // cold-start retry reports each wait on a waking app), drawn as the waking
  // line in the same place.
  const {
    wait: connectWait,
    onSaturationWait,
    coldStartRetry,
    clear: clearConnectWait,
  } = useConnectWait();
  const adapters = useMemo(
    () =>
      adaptersProp ??
      createWebAdapters({
        // The widget's end-user budget (guuey#406): three retries, each one
        // shown, before the refusal surfaces as the plain busy error.
        saturationAttempts: SATURATION_RETRIES,
        onSaturationWait,
        coldStartRetry,
        ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        ...(hasAccessToken
          ? {
              getAccessToken: (opts?: { forceRefresh?: boolean }) =>
                getAccessTokenRef.current?.(opts) ?? Promise.resolve(null),
            }
          : {}),
        ...(hasGuestSecret
          ? { getGuestSecret: () => getGuestSecretRef.current?.() ?? null }
          : {}),
      }),
    [adaptersProp, apiBaseUrl, hasAccessToken, hasGuestSecret, onSaturationWait, coldStartRetry],
  );
  // A card's `ui/message` becomes the next turn only through the kit's own
  // sink, so the kit declares it only where that sink is provably in effect
  // (see `GuueyChatProps.viewMessageTurns`). Without the declaration a server
  // cannot rely on a view's message becoming a turn, so it holds each render
  // turn open until the view answers.
  const advertiseViewMessageTurns = viewMessageTurnsProp ?? kitSinkInEffect(viewProps);
  const invoke = useAgentInvoke({
    endpointUrl,
    ...(appId !== undefined ? { appId } : {}),
    ...(agentMode !== undefined ? { mode: agentMode } : {}),
    ...(advertiseViewMessageTurns ? { capabilities: VIEW_MESSAGE_TURN_CAPABILITIES } : {}),
    adapters,
    preserveBlocks: true,
  });

  // guuey#2031 — the tap echo: a card tap draws at once as the visitor's
  // action turn (the chip's own words when this kit holds the card's props),
  // and the doorbell's send replaces it in place. Mounted cards are looked up
  // at TAP time through a ref the plan fills below (a card painted before a
  // reload carries its props in its own document); counts-only withdrawals
  // reach the debug sink under the debug policy only.
  const mountedForRef = useRef<(renderSessionId: string) => MountedCardProps | undefined>(() => undefined);
  const tapDebugRef = useRef<((reason: TapWithdrawReason) => void) | undefined>(undefined);
  const echo = useTapEcho({
    invoke,
    mountedFor: (renderSessionId) => mountedForRef.current(renderSessionId),
    onWithdraw: (reason) => tapDebugRef.current?.(reason),
  });
  const echoRef = useRef(echo);
  echoRef.current = echo;

  // Default reader (guuey#221): built over the SAME identity as the
  // transport/history, targeting the pod door (live turns) then the
  // platform door (persisted). The threadId hydrates after mount and can
  // change on reset, so the reader is a stable function that reads the
  // CURRENT thread through a ref — `useTranscript` sees one reader for the
  // component's life and never re-resolves every mount on a thread flip.
  const threadIdRef = useRef<string | null>(invoke.threadId);
  threadIdRef.current = invoke.threadId;
  const defaultReader = useMemo<UiResourceReader | undefined>(() => {
    // Batteries condition (guuey#368 widened): EITHER half builds the
    // reader — apiBaseUrl alone is a platform-door (history) reader,
    // endpointUrl alone is a POD-ONLY reader (live turns; the `guuey dev`
    // scaffold's exact shape — its transport mints no threadId, and the
    // old no-thread-no-read gate starved the pod door to ZERO requests
    // while the tool layer reported success: the docs-lab repro).
    if (apiBaseUrl === undefined && (endpointUrl === undefined || endpointUrl === null)) {
      return undefined;
    }
    // guuey#421 CLOSURE FIX (the live-capture find): this wrapper used to
    // take only `resourceUri`, silently DROPPING the hints param — so the
    // inner reader never learned `origin: "history"` and dialed the pod
    // first on every old-conversation load (the 404 pair, warm/cold
    // dependent). The #421 gate lived in agent-client all along; the
    // kit-default wrapper starved it. Thread the hints through.
    return async (resourceUri: string, hints?: Parameters<UiResourceReader>[1]) => {
      const threadId = threadIdRef.current;
      // Assembled per read: `createUiResourceReader` is a cheap closure, and
      // the guest secret is re-resolved each call so a rotation takes
      // effect immediately — the same per-request property
      // `createWebAdapters` documents for its own resolvers.
      // Getters read through the refs at CALL time — the reader's identity
      // survives a host re-render handing in fresh arrows, and a rotated
      // getter takes effect on the next read (the same per-request property
      // `createWebAdapters` documents).
      const getToken = getAccessTokenRef.current;
      const getGuest = getGuestSecretRef.current;
      const read = createUiResourceReader({
        // Platform-door halves ride only when they exist — the reader is
        // pod-only-legal since #368 (a null thread no longer blocks the
        // pod door, which never needed one).
        ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        ...(threadId !== null ? { threadId } : {}),
        endpointUrl,
        ...(getToken !== undefined ? { getAccessToken: getToken } : {}),
        guestSecret: getGuest !== undefined ? getGuest() : null,
      });
      return read(resourceUri, hints);
    };
  }, [apiBaseUrl, endpointUrl]);
  const effectiveReader = reader ?? defaultReader;

  // Structurally-stable overrides: `policy={{ view: { … } }}` inline
  // literals keep ONE identity while their contents hold still, so the
  // policy (and through it the plan) does not re-mint per host render.
  const stablePolicyOverrides = useStructuralIdentity(policyOverrides);
  const stableStringOverrides = useStructuralIdentity(stringOverrides);
  const policy = useMemo(() => {
    const factory = preset === "debug" ? debugPolicy : calmPolicy;
    const strings: ChatStrings = {
      ...defaultChatStrings,
      ...stablePolicyOverrides?.strings,
      ...stableStringOverrides,
    };
    return factory({ ...stablePolicyOverrides, strings });
  }, [preset, stablePolicyOverrides, stableStringOverrides]);

  const { inputs, resolvePrompt, answerHitlPrompt } = useTranscriptInputs(invoke);
  // A wait belongs to the turn's `connecting` phase: any status change (the
  // retry got through, the refusal surfaced, a stop, the next turn) ends it.
  useEffect(() => {
    clearConnectWait();
  }, [invoke.status, clearConnectWait]);
  // Memoized: once a chip is selected (`promotedViewKey` set) this object
  // is on the plan's identity path — a per-render fresh spread here was the
  // second leg of the render loop the template surfaced.
  const transcriptInputs = useMemo(
    () =>
      promotedViewKey === undefined && echo.pendingTaps.length === 0 && connectWait === null
        ? inputs
        : {
            ...inputs,
            ...(promotedViewKey !== undefined ? { promotedViewKey } : {}),
            // guuey#2031: taps drawn before their turn is sent.
            ...(echo.pendingTaps.length > 0 ? { pendingTaps: echo.pendingTaps } : {}),
            ...(connectWait !== null ? { connectWait } : {}),
          },
    [inputs, promotedViewKey, echo.pendingTaps, connectWait],
  );
  const { plan, toggle, resolvedMounts, onViewPhase, onViewDiagnosis } = useTranscript({
    inputs: transcriptInputs,
    policy,
    ...(effectiveReader !== undefined ? { reader: effectiveReader } : {}),
    ...(onDebugEvent !== undefined ? { onDebugEvent } : {}),
  });
  // guuey#2031 (the history-card path): the props a mounted card's own
  // document paints from, by render session — read off the plan's view roster
  // and the locator resolutions at TAP time only (a shell parse per tap, never
  // per render). The newest mount of a session wins.
  mountedForRef.current = (renderSessionId: string): MountedCardProps | undefined => {
    let found: MountedCardProps | undefined;
    for (const view of plan.views) {
      const resolved = resolvedMounts.get(view.key);
      const mount =
        resolved !== undefined && resolved !== "expired"
          ? resolved
          : view.mount !== null && view.mount.channel !== "locator"
            ? view.mount
            : undefined;
      if (mount === undefined) continue;
      const props = mountedCardProps(mount);
      if (props !== undefined && props.sessionId === renderSessionId) found = props;
    }
    return found;
  };
  tapDebugRef.current =
    policy.debugDetail && onDebugEvent !== undefined ? (reason) => onDebugEvent({ type: "tap-withdrawn", reason }) : undefined;

  // guuey#301: hand the host the plan's view roster whenever it changes —
  // the stage renders the selected mount from it. Locator entries carry
  // the RESOLUTION overlay (a stage mounts material, not identities):
  // resolved material replaces the locator mount, a failed read surfaces
  // as the expired phase. Ref'd callback so a host passing a fresh
  // closure each render doesn't loop the effect.
  const onViewsChangeRef = useRef(onViewsChange);
  onViewsChangeRef.current = onViewsChange;
  useEffect(() => {
    if (onViewsChangeRef.current === undefined) return;
    const overlaid = plan.views.map((view) => {
      const resolved = resolvedMounts.get(view.key);
      if (resolved === undefined) return view;
      if (resolved === "expired") return { ...view, phase: "expired" as const };
      return { ...view, mount: resolved };
    });
    onViewsChangeRef.current(overlaid);
  }, [plan.views, resolvedMounts]);

  // The theme announce, completed at the kit tier (guuey#302): every
  // inline mount carries `hostContext.theme` from the transcript's `mode`
  // — render bundles read it at ui/initialize (ggui precedence: slice
  // wins, host falls back — their #551/#573). A caller's explicit
  // `viewProps.hostContext` keys win; `theme` is only defaulted. Hosts
  // mounting views DIRECTLY (a canvas over the roster) announce on their
  // own <GuueyView hostContext> — this covers the kit's own mounts.
  // ── Composer ─────────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Browser form-field heuristics (a11y/autofill lints) flag a field with
  // neither id nor name on every embedding site. useId keeps the id unique
  // when several chats mount on one page — a static id would collide.
  const composerId = useId();
  const busy = invoke.status !== "ready";
  // guuey#1038 — a LISTEN is a turn waiting on the USER. ggui's `ggui_consume`
  // (wait for the user to act on a card; bounded and abort-aware on their
  // side — cancelling the in-flight call ends it, which is what a manual
  // Stop did) used to hold the composer shut until the user stopped the
  // tool call by hand. While the
  // pending tool is the listen, the composer stays open and a reply ends the
  // listen and sends — the user answers in either channel, card or text.
  const waitingOnUser = isWaitingOnUser(invoke.status, invoke.activeTool);
  /** A reply typed during a listen: sent once the aborted listen has unwound (the hook refuses `send` mid-turn by design). */
  const replyAfterListenRef = useRef<{ text: string; attachments: readonly ImageAttachment[] } | null>(null);
  useEffect(() => {
    if (invoke.status !== "ready") return;
    const reply = replyAfterListenRef.current;
    if (reply === null) return;
    replyAfterListenRef.current = null;
    analytics.messageSent();
    void invoke.send(reply.text, sendOptionsFor(reply.attachments)).catch(() => {
      // The hook surfaces the failure (`error` / R0 failed-send).
    });
  }, [invoke.status, invoke, analytics]);
  // guuey#2293 — the images waiting to go with the next send, and the status
  // line naming a file the composer did not take. A ref mirrors the list so
  // a pick judges the count and the turn's size against the CURRENT list,
  // not a render-old closure (two quick picks must not both see room).
  const [pendingImages, setPendingImagesState] = useState<readonly PendingImage[]>([]);
  const pendingImagesRef = useRef<readonly PendingImage[]>([]);
  const setPendingImages = useCallback((next: readonly PendingImage[]): void => {
    pendingImagesRef.current = next;
    setPendingImagesState(next);
  }, []);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImageIdRef = useRef(0);
  // guuey#605 — the connect-first gate. While an `authMode:'upfront'` OAuth
  // server is pending connection the RUNTIME refuses every turn before any
  // model call, so inviting a message here would only spend one to be told
  // the same thing. The gate is the plan's typed refusal, and it releases the
  // moment the card is dismissed or answered (the pod re-cards next turn) —
  // the client never claims more than the pod enforces, and no one dead-ends.
  const authRequired = plan.authRequired;
  const available = endpointUrl !== null;
  // guuey#2355: the agent ended this conversation; the composer holds until
  // the person opens a new one (the banner's control).
  const threadClosed = plan.threadClosed !== null;
  const canSend =
    available &&
    (!busy || waitingOnUser) &&
    authRequired === null &&
    !threadClosed &&
    (input.trim() !== "" || pendingImages.length > 0);

  // ── The imperative seam (guuey#210) ──────────────────────────────────
  // ONE stable handle for the component's whole life (hosts capture it in
  // `onReady` and keep it), reading live truth through a ref so a call
  // always sees the CURRENT gate — never a stale closure's.
  const liveRef = useRef({ available, busy, invoke, onReady });
  useEffect(() => {
    liveRef.current = { available, busy, invoke, onReady };
  });

  // The DEFAULT ACTION RELAY (guuey#335 — the Confirm bug):
  // pod-then-persisted, built over the SAME identity as the reader, thread
  // read through the ref at CALL time. Without it, a kit-mounted render's
  // tools/call hits an initialize-only host and the card's interaction
  // visibly fails — the #221 batteries-included treatment, applied to the
  // ACTION half. No thread yet ⇒ the in-band unavailable result (a card
  // cannot exist before its thread, but a race answers honestly).
  const defaultOnCallTool = useMemo<((request: UiActionRequest) => Promise<McpToolCallResult>) | undefined>(() => {
    if (apiBaseUrl === undefined) return undefined;
    return async (request) => {
      const threadId = threadIdRef.current;
      if (threadId === null) return unavailableToolCallResult();
      const getToken = getAccessTokenRef.current;
      const getGuest = getGuestSecretRef.current;
      const relay = createUiActionRelay({
        apiBaseUrl,
        threadId,
        endpointUrl,
        ...(getToken !== undefined ? { getAccessToken: getToken } : {}),
        guestSecret: getGuest !== undefined ? getGuest() : null,
      });
      return relay(request);
    };
  }, [apiBaseUrl, endpointUrl]);

  // Model-context sink (guuey#335): the snapshot is a complement (producers
  // mirror it server-side), so recording to the debug surface is the honest
  // kit default — and answering the method keeps strict producers green.
  const onDebugEventRef = useRef(onDebugEvent);
  onDebugEventRef.current = onDebugEvent;

  // The guest → signed-in transition: the host now hands a bearer where the
  // surface ran as a guest (a guest secret, or a cookie identity with neither
  // getter). Move the guest's threads in this app to the signed-in user and
  // keep the SAME thread — once it is theirs, the bearer's next turn carries
  // on in it instead of starting a new one. The guest secret is read BEFORE
  // rotation (the merge must present the identity that owns the threads), and
  // rotated only after a merge that answered: threads created under it later
  // stay unlinkable, and a failed or unsupported merge leaves the guest's
  // history reachable. A run the guest left paused does not resume after the
  // merge; the user sends again. Presence flips, not getter identity, trigger
  // it (the same rule the adapters follow).
  const signedInRef = useRef(hasAccessToken);
  useEffect(() => {
    const wasSignedIn = signedInRef.current;
    signedInRef.current = hasAccessToken;
    if (wasSignedIn || !hasAccessToken) return;
    const threadId = threadIdRef.current;
    const base = apiBaseUrlRef.current;
    const mergeAppId = appIdRef.current;
    const getToken = getAccessTokenRef.current;
    if (base === undefined || mergeAppId === undefined || getToken === undefined) {
      onDebugEventRef.current?.({ type: "guest-merge", threadId, outcome: "skipped" });
      return;
    }
    const getGuest = lastGuestGetterRef.current;
    const guestSecret = getGuest !== undefined ? getGuest() : null;
    void mergeGuestThreads({
      apiBaseUrl: base,
      appId: mergeAppId,
      getAccessToken: getToken,
      getGuestSecret: () => guestSecret,
      ...(threadId !== null ? { threadIds: [threadId] } : {}),
    }).then((result) => {
      if (!result.supported) {
        onDebugEventRef.current?.({ type: "guest-merge", threadId, outcome: "unsupported" });
        return;
      }
      if (!result.ok) {
        onDebugEventRef.current?.({ type: "guest-merge", threadId, outcome: "failed" });
        return;
      }
      onDebugEventRef.current?.({ type: "guest-merge", threadId, outcome: "merged", moved: result.moved });
      onGuestSecretRotateRef.current?.();
    });
  }, [hasAccessToken]);
  const defaultOnUpdateModelContext = useCallback((params: { [key: string]: unknown }) => {
    onDebugEventRef.current?.({
      type: "model-context-update",
      byteSize: JSON.stringify(params)?.length ?? 0,
    });
  }, []);

  // guuey#422: the kit default DOES NOT stage the ggui semantic carrier
  // any more — post-turn actions RELAY (the #222 platform door serves
  // persisted-card actions after the turn), so the runtime receives its
  // REAL result envelope and its #440 classifier grades honestly; the
  // post-turn agent turn then starts through the ui/message doorbell
  // (the sink below). The #356 staging seam remains a PUBLIC export
  // (withActionStaging) for hosts that choose the composer-staging UX;
  // no first-party surface applies it any more (the widget converged on
  // this relay+doorbell path in guuey#404).
  const stagedDefaultOnCallTool = defaultOnCallTool;
  // guuey#2031: the kit relay, wrapped by the tap echo — substituted only on a
  // slot that takes both the kit relay and the kit sink (see
  // `viewPropsWithThemeAnnounce`). `wrapCallTool` is stable for the chat's life.
  const echoWrapCallTool = echo.wrapCallTool;
  const echoOnCallTool = useMemo(
    () => (stagedDefaultOnCallTool === undefined ? undefined : echoWrapCallTool(stagedDefaultOnCallTool)),
    [stagedDefaultOnCallTool, echoWrapCallTool],
  );

  // The ui/message sink (guuey#422): the view hands the host role-user
  // content (ggui's #440 doorbell — the model directive that drains a
  // post-turn gesture). Forward through the SAME gate as handle.send: a
  // real turn starts, the agent calls ggui_consume, the card repaints.
  // Busy/unavailable ⇒ dropped (the doorbell fires post-turn by design;
  // mid-turn the consume pipe is live and no doorbell fires).
  // guuey#422 close-condition 1 (ggui review): queue-and-drain — while a
  // turn is live the directive queues behind it (never cancelling it), and
  // the idle transition drains one per turn.
  // guuey#1706: the sink REPORTS delivery, and the view host answers the
  // view's `ui/message` from it (`{}` once the message BECAME a turn,
  // `{ isError: true }` when it could not; `{}` at the host's cap if it is
  // still queued). So a queued doorbell resolves only when the drain SENDS
  // it; an unavailable chat resolves `{ delivered: false }` and still logs
  // LOUD. Dedupe is per QUEUE, never across time: identical texts posted
  // during the same live turn collapse onto one send (a double-click) and
  // all resolve with it — "delivered" for the second means "became the same
  // turn".
  //
  // guuey#2031: the doorbell's tap. A doorbell whose structured mirror names a
  // tap the echo holds claims it; its send carries the id and words of the one
  // entry the echo marks sent for it (marked first, so the two never differ),
  // and merged doorbells send as ONE turn under the first waiting tap's id with
  // every tap's words in order. Every refusal withdraws the drawn tap in the
  // doorbell's own task, a doorbell with no text included, so no refused tap
  // stays drawn for the grace.
  const pendingDoorbellsRef = useRef<
    Array<{ text: string; waiters: Array<(delivery: UserMessageDelivery) => void>; taps: ClaimedTap[] }>
  >([]);
  const defaultOnUserMessage = useCallback((params: { [key: string]: unknown }): Promise<UserMessageDelivery> => {
    const echoNow = echoRef.current;
    const tap = echoNow.claimDoorbell(params);
    const content = params["content"];
    const text = Array.isArray(content)
      ? content
          .map((b) =>
            typeof b === "object" && b !== null && "text" in b && typeof b.text === "string"
              ? b.text
              : "",
          )
          .filter((t) => t !== "")
          .join("\n")
      : "";
    if (text.trim() === "") {
      if (tap !== null) echoNow.withdraw(tap.id, "refused");
      return Promise.resolve({ delivered: false, reason: "no text content" });
    }
    const live = liveRef.current;
    if (!live.available) {
      if (tap !== null) echoNow.withdraw(tap.id, "refused");
      console.warn(
        "[guuey] ui/message doorbell dropped — chat is unavailable (endpointUrl null); the view's gesture cannot start a turn here.",
      );
      return Promise.resolve({ delivered: false, reason: "chat is unavailable" });
    }
    if (live.busy) {
      return new Promise<UserMessageDelivery>((resolve) => {
        const same = pendingDoorbellsRef.current.find((entry) => entry.text === text);
        if (same) {
          same.waiters.push(resolve);
          if (tap !== null) same.taps.push(tap);
        } else pendingDoorbellsRef.current.push({ text, waiters: [resolve], taps: tap !== null ? [tap] : [] });
      });
    }
    // One source: the send carries exactly the entry the echo marked sent.
    const sent = tap !== null ? echoNow.markSent([tap.id]) : null;
    // A send step that throws SYNCHRONOUSLY leaves no turn behind the entry
    // just marked sent: the tap is withdrawn at once (`not-sent`, instead of
    // after the sent grace), the throw is logged (the view host answers the
    // view `{ isError: true }` from the rejection but drops the error), and
    // the sink rejects. An async failure stays the hook's failed-turn state.
    try {
      analytics.messageSent();
      void live.invoke.send(text, tapSendOptions(sent)).catch(() => {
        // The hook owns failure surfacing, same as every send path.
      });
    } catch (error) {
      if (tap !== null) echoNow.withdraw(tap.id, "not-sent");
      console.error("[guuey] ui/message doorbell send threw — taps withdrawn.", error);
      return Promise.reject(error);
    }
    return Promise.resolve({ delivered: true });
  }, [analytics]);

  // guuey#403: the turn-lifecycle edges. The busy TRANSITION is the one
  // truthful seam every send path crosses (composer, handle, doorbell,
  // drain, retry) and gate-refused sends never do; status leaves `ready`
  // only via a real send (hydration and history reads never touch it).
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current === busy) return;
    prevBusyRef.current = busy;
    onActivityRef.current?.({ type: busy ? "submit" : "settled" });
  }, [busy]);

  // The drain: one queued doorbell per idle transition — its send flips
  // busy again, and the NEXT idle drains the next (never a turn storm).
  useEffect(() => {
    if (busy || pendingDoorbellsRef.current.length === 0) return;
    const next = pendingDoorbellsRef.current.shift();
    if (next === undefined) return;
    const live = liveRef.current;
    if (!live.available) {
      console.warn("[guuey] queued ui/message doorbell dropped — chat became unavailable.");
      for (const tap of next.taps) echoRef.current.withdraw(tap.id, "refused");
      for (const waiter of next.waiters) waiter({ delivered: false, reason: "chat became unavailable" });
      return;
    }
    const sent = next.taps.length > 0 ? echoRef.current.markSent(next.taps.map((t) => t.id)) : null;
    // Same rule as the direct ring: a synchronous throw means no turn, so
    // every merged tap is withdrawn and every waiter hears it before the
    // error propagates out of the effect as it did before.
    try {
      analytics.messageSent();
      void live.invoke.send(next.text, tapSendOptions(sent)).catch(() => {
        // The hook owns failure surfacing, same as every send path.
      });
    } catch (error) {
      for (const tap of next.taps) echoRef.current.withdraw(tap.id, "not-sent");
      console.error("[guuey] queued ui/message doorbell send threw — taps withdrawn.", error);
      for (const waiter of next.waiters) waiter({ delivered: false, reason: "the chat send threw" });
      throw error;
    }
    for (const waiter of next.waiters) waiter({ delivered: true });
  }, [busy, analytics]);

  // guuey#522: the kit default for `ui/open-link` NEVER navigates
  // sight-unseen — the ask surfaces as a disclosure affordance (host +
  // full URL + Open/Dismiss) and the OPEN is the human's own anchor
  // click, so the browser's activation gate and the review posture agree
  // by construction. ONE pending ask at a time, newest replaces (a
  // card spamming asks can never grow an unbounded stack).
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  // guuey#526: the two-tap confirm window for the clear affordance (an
  // accidental tap must not nuke a conversation; a second tap within the
  // window does — the state auto-expires).
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [clearArmed]);
  const showClearAffordance = clearAffordance ?? getGuestSecret !== undefined;
  // guuey#533: the render-side mirror of the card projection's emit caps
  // (4 shown / <=80 chars / blank-rejected) — same defense posture as the
  // table normalizer: the kit is public npm and cannot assume every host
  // routed content through platform's write gate.
  const chips = useMemo<readonly string[]>(() => {
    if (suggestions === false || suggestions === undefined) return [];
    return suggestions
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c.length <= 80)
      .slice(0, 4);
  }, [suggestions]);
  const sendSuggestion = useCallback((text: string): void => {
    const live = liveRef.current;
    // Exactly the Send button's gate (the #210 rule): unavailable, busy,
    // or blank -> the tap is a no-op, never a bypass. The typed draft is
    // left untouched (a chip send must not eat a half-typed message).
    if (!live.available || live.busy || text.trim() === "") return;
    analytics.messageSent();
    void live.invoke.send(text).catch(() => {
      // Same contract as submit: the hook owns failure surfacing.
    });
  }, [analytics]);
  const defaultOnOpenLink = useCallback((url: string) => {
    setPendingLink(url);
  }, []);

  // guuey#1195: the theme's declared faces — injected into THIS document
  // (the frame page, the standalone page, or the host page under an inline
  // shadow mount) and handed to every card as `hostContext.styles.css.fonts`.
  const fontsCss = useMemo(() => facesCss(theme.typography.faces), [theme.typography.faces]);
  useHostFaces(fontsCss);
  // guuey#1128: the theme's palette as the spec's `--color-*` slots — the
  // fallback layer ggui merges beneath the app theme (ggui#572/#573), so a
  // themed app's un-stated tokens take the theme's colours, not ggui's defaults.
  const styleVariables = useMemo(() => hostStyleVariables(theme, mode), [theme, mode]);

  const effectiveViewProps = useMemo<TranscriptItemContext["viewProps"]>(
    () =>
      viewPropsWithThemeAnnounce(
        viewProps,
        mode,
        {
          ...(stagedDefaultOnCallTool !== undefined ? { onCallTool: stagedDefaultOnCallTool } : {}),
          onUpdateModelContext: defaultOnUpdateModelContext,
          onUserMessage: defaultOnUserMessage,
          onOpenLink: defaultOnOpenLink,
        },
        fontsCss,
        styleVariables,
        echoOnCallTool,
      ),
    [
      viewProps,
      mode,
      stagedDefaultOnCallTool,
      defaultOnUpdateModelContext,
      defaultOnUserMessage,
      defaultOnOpenLink,
      fontsCss,
      styleVariables,
      echoOnCallTool,
    ],
  );

  // The canvas-host door (guuey#335): a host mounting views DIRECTLY from
  // the roster (the chat-rail shell) needs the SAME slot wiring the kit's
  // inline mounts get — theme announce, action relay, context sink. Read
  // through a ref so the lifetime-stable handle always hands out current
  // wiring; a caller-passed FUNCTION-form viewProps resolves per transcript
  // item only, so the handle returns the kit defaults in that case.
  const staticSlotPropsRef = useRef<ViewSlotProps>({});
  staticSlotPropsRef.current =
    typeof effectiveViewProps === "function"
      ? {
          // Both kit defaults ride this branch, so the echo relay does too (guuey#2031).
          ...(echoOnCallTool !== undefined ? { onCallTool: echoOnCallTool } : {}),
          onUpdateModelContext: defaultOnUpdateModelContext,
          onUserMessage: defaultOnUserMessage,
          onOpenLink: defaultOnOpenLink,
          hostContext: { theme: mode, ...hostContextStyles(fontsCss, styleVariables) },
        }
      : (effectiveViewProps ?? {});

  const handle = useMemo<GuueyChatHandle>(
    () => ({
      send: (text: string, opts?: { inputKind?: InputKind }): boolean => {
        const live = liveRef.current;
        const trimmed = text.trim();
        // guuey#2549: a turn without words; the agent's runtime judges it.
        const inputKind = trimmed === "" ? opts?.inputKind : undefined;
        // Exactly the Send button's gate — a handle send never bypasses it.
        if (!live.available || live.busy || (trimmed === "" && inputKind === undefined)) return false;
        analytics.messageSent();
        void live.invoke.send(trimmed, inputKind !== undefined ? { inputKind } : undefined).catch(() => {
          // Same contract as submit: the hook owns failure surfacing.
        });
        return true;
      },
      prefill: (text: string, opts?: { focus?: boolean; append?: boolean }): void => {
        setInput((prev) =>
          // The widget's staged-composer semantic: append joins with a
          // space onto a non-empty draft, never clobbers it.
          opts?.append === true && prev.trim() !== "" ? `${prev.trimEnd()} ${text}` : text,
        );
        if (opts?.focus !== false) inputRef.current?.focus();
      },
      focusComposer: (): void => {
        inputRef.current?.focus();
      },
      clearConversation: (): void => {
        const live = liveRef.current;
        // Contract ordering (guuey#526, platform's frozen comment): abort
        // FIRST — a completing turn can re-persist its own rows after the
        // delete. Capture the id + guest secret BEFORE anything clears or
        // rotates them: the delete must authenticate as the identity that
        // OWNS the thread.
        live.invoke.abort();
        const threadId = threadIdRef.current;
        const getGuest = getGuestSecretRef.current;
        const guestSecret = getGuest !== undefined ? getGuest() : null;
        if (apiBaseUrlRef.current !== undefined && threadId !== null) {
          // Best-effort server erasure — fire-and-forget, never blocks the
          // local clear. 200 and 404 are both "deleted" (idempotent by
          // contract); denied/failed still cleared locally below (the
          // unlinkability fallback) and surface ONLY as a debug line.
          void deleteThread({
            apiBaseUrl: apiBaseUrlRef.current,
            threadId,
            ...(getAccessTokenRef.current !== undefined
              ? { getAccessToken: getAccessTokenRef.current }
              : {}),
            guestSecret,
          }).then((outcome) => {
            onDebugEventRef.current?.({ type: "thread-delete", threadId, outcome });
          });
        } else {
          onDebugEventRef.current?.({ type: "thread-delete", threadId, outcome: "skipped" });
        }
        // The hook's reset owns the durable local half (pointer + storage
        // key, transcript/fold/cards); the kit clears ITS OWN residue —
        // the typed draft, a pending link ask, queued doorbells — so the
        // device holds nothing of the conversation.
        live.invoke.reset();
        setInput("");
        setPendingLink(null);
        pendingDoorbellsRef.current = [];
        echoRef.current.reset();
        // Rotation LAST: the delete above already captured the old
        // identity, so the fresh secret is a stranger to even an orphaned
        // server row.
        onGuestSecretRotateRef.current?.();
      },
      // A getter, not a captured value: the handle is created once, but the
      // thread hydrates after mount and can change — reads go through the
      // same ref the default reader uses, so it is always the live id.
      get threadId(): string | null {
        return threadIdRef.current;
      },
      // Live-read like `threadId`: the latest offer the hook holds.
      get acceptedInputKinds(): readonly InputKind[] | null {
        return liveRef.current.invoke.acceptedInputKinds;
      },
      // Same live-read discipline as `threadId`: the ref always holds the
      // CURRENT kit wiring (guuey#335 — the canvas-host door).
      viewSlotProps: (): ViewSlotProps => staticSlotPropsRef.current,
      markOpened: (): void => {
        analytics.opened();
      },
    }),
    [analytics],
  );

  useImperativeHandle(ref, () => handle, [handle]);

  // `onThread` fires on the first hydrated id and on each DISTINCT change —
  // never for null, never twice for the same id (a StrictMode remount
  // re-runs the effect with the same value; the last-notified ref absorbs
  // it). Read the callback through the live ref so an inline arrow prop
  // doesn't churn the effect.
  const lastNotifiedThreadRef = useRef<string | null>(null);
  const onThreadRef = useRef(onThread);
  onThreadRef.current = onThread;
  useEffect(() => {
    const id = invoke.threadId;
    if (id === null || id === lastNotifiedThreadRef.current) return;
    lastNotifiedThreadRef.current = id;
    onThreadRef.current?.(id);
  }, [invoke.threadId]);

  // `onReady` fires once per instance, on mount, with the stable handle
  // (guarded ref: StrictMode's remount cycle must not double-fire it).
  const readyFiredRef = useRef(false);
  useEffect(() => {
    if (readyFiredRef.current) return;
    readyFiredRef.current = true;
    liveRef.current.onReady?.(handle);
  }, [handle]);

  const submit = useCallback((): void => {
    const typed = input.trim();
    const images = pendingImagesRef.current.map((p) => p.attachment);
    // guuey#605: the connect-first gate belongs on the SEND path too, not
    // just the disabled attribute — an Enter keypress reaches here directly.
    if ((typed === "" && images.length === 0) || !available || authRequired !== null || threadClosed) return;
    // guuey#2293: images with no words still need a non-empty input (every
    // runtime refuses an empty one); the kit's neutral line stands in.
    const text = typed !== "" ? typed : policy.strings.attachmentsOnlyInput;
    if (busy) {
      if (!waitingOnUser) return;
      // guuey#1038: a reply during a listen ENDS the listen (abort = the
      // cancel ggui's handler honours) and goes out as the next turn once
      // the hook is ready again — one gesture, no manual Stop.
      replyAfterListenRef.current = { text, attachments: images };
      setInput("");
      setPendingImages([]);
      setAttachmentNotice(null);
      invoke.abort();
      return;
    }
    setInput("");
    setPendingImages([]);
    setAttachmentNotice(null);
    analytics.messageSent();
    void invoke.send(text, sendOptionsFor(images)).catch(() => {
      // The hook surfaces the failure (`error` / R0 failed-send).
    });
  }, [input, available, busy, waitingOnUser, authRequired, threadClosed, invoke, analytics, policy.strings, setPendingImages]);

  // guuey#2293 — take picked or pasted files: the count and the turn's size
  // are judged against the list as it stands, each file is read (and redrawn
  // smaller where the browser can), and every file not taken is named.
  const addImageFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      const refusals: string[] = [];
      const refuse = (name: string, reason: AttachmentRefusalReason): void => {
        refusals.push(policy.strings.attachmentRefused(name, reason));
      };
      const room = IMAGE_ATTACHMENTS_MAX_COUNT - pendingImagesRef.current.length;
      const taken = files.slice(0, Math.max(0, room));
      for (const file of files.slice(taken.length)) refuse(file.name, "too_many");
      const results = await Promise.all(taken.map((file) => readImageFile(file)));
      let next = pendingImagesRef.current;
      for (const result of results) {
        if (!result.ok) {
          refuse(result.name, result.reason);
          continue;
        }
        if (next.length >= IMAGE_ATTACHMENTS_MAX_COUNT) {
          refuse(result.name, "too_many");
          continue;
        }
        const total = next.reduce((sum, p) => sum + p.attachment.data.length, 0);
        if (total + result.attachment.data.length > IMAGE_ATTACHMENTS_MAX_TOTAL_BASE64_CHARS) {
          refuse(result.name, "too_large");
          continue;
        }
        pendingImageIdRef.current += 1;
        next = [
          ...next,
          { id: `img-${pendingImageIdRef.current}`, name: result.name, attachment: result.attachment, previewUrl: result.previewUrl },
        ];
      }
      setPendingImages(next);
      setAttachmentNotice(refusals.length > 0 ? refusals.join(" ") : null);
    },
    [policy.strings, setPendingImages],
  );

  const removePendingImage = useCallback(
    (id: string): void => {
      setPendingImages(pendingImagesRef.current.filter((p) => p.id !== id));
      setAttachmentNotice(null);
      inputRef.current?.focus();
    },
    [setPendingImages],
  );

  // guuey#2355: open a new conversation from the closed one. The hook's reset
  // drops the closed thread (pointer + storage, transcript, the closed state);
  // the kit clears its own residue. The closed thread is kept on the server:
  // this is "start over", not the forget-this-device clear.
  const startNewConversation = useCallback((): void => {
    invoke.reset();
    setInput("");
    setPendingImages([]);
    setAttachmentNotice(null);
    setPendingLink(null);
    pendingDoorbellsRef.current = [];
    echoRef.current.reset();
  }, [invoke, setPendingImages]);

  const handleRetry = useCallback(
    (item: UserMessageItem) => {
      // The kit's retry rule (`retryInPlaceArgs`): the turn goes again as it
      // was (an action turn with its words beside the directive, guuey#2031;
      // a turn without words goes again without words, guuey#2549), in the failed row's
      // place, so it is drawn once, never beside its old "Couldn't send" row
      // (guuey#2608).
      void invoke.send(...retryInPlaceArgs(item)).catch(() => {
        // Same contract as submit: the hook owns failure surfacing.
      });
    },
    [invoke],
  );

  // guuey#178: the broker's return notice (`?connected=` / `?error=`), read
  // + stripped off the address bar once on mount.
  const oauthReturn = useOAuthReturn();

  const handlePromptAction = useCallback(
    (item: PromptItem, action: "accept" | "decline" | "dismiss" | { grantModeId: string }) => {
      if (item.promptKind === "hitl") {
        // guuey#1860: no door or broker answers this ask; the card offers no
        // action, and nothing is dispatched if one is called anyway.
        if (item.answer === "none") return;
        // The OAuth arm: the answer is the redirect (no pod door, no
        // `onHitlAnswer`); the ledger records the pick and the link opens.
        if (
          oauthPromptAction({
            item,
            action,
            answerHitlPrompt,
            ...(oauthReturnTo !== undefined ? { returnTo: oauthReturnTo } : {}),
            ...(onOAuthAuthorize !== undefined ? { open: onOAuthAuthorize } : {}),
          })
        ) {
          onPromptAction?.(item, action);
          return;
        }
        const answer = answerHitlPrompt(
          item.ask,
          typeof action === "object" ? action : action === "accept" ? "accept" : action,
        );
        onHitlAnswer?.(answer, item.ask);
        onPromptAction?.(item, action);
        return;
      }
      // Profile prompts only ever receive the string actions (the default
      // card renders no mode buttons for them).
      if (typeof action !== "object") resolvePrompt(item.promptId, PROMPT_STATE[action]);
      onPromptAction?.(item, action);
    },
    [resolvePrompt, answerHitlPrompt, onHitlAnswer, onPromptAction, oauthReturnTo, onOAuthAuthorize],
  );

  const strings = policy.strings;

  // The resolved theme is stamped HERE, on the outer surface, not only on
  // the transcript root (guuey#1126, audit G24): the chips row, clear-row,
  // link-ask, OAuth notice and composer are SIBLINGS of `.guuey-chat`, and
  // a `var(--guuey-chat-X, var(--_guuey-chat-X))` read resolves only from
  // an ancestor — stamped on the root alone, none of that chrome ever took
  // the app's theme. `<Transcript>` keeps its own stamp for standalone
  // consumers (same values, so nesting never disagrees); the caller's
  // `style` merges over, as it does on the root.
  const surfaceStyle: CSSProperties = { ...themeCssVars(theme, mode), ...style };

  return (
    <div
      className={`guuey-chat-surface${className !== undefined ? ` ${className}` : ""}`}
      // guuey#1152: the `::part()` hooks (`parts.ts`) — a shadow-root host
      // restyles the surface, chips and composer through these, never
      // through the class names, which stay the light-DOM contract.
      part={PARTS.surface}
      style={surfaceStyle}
      // `helper_cta_clicked`: every link this chat renders (the transcript's
      // markdown and media links, the link-ask's Open, a header's own links) —
      // one capture-phase listener, so no renderer needs to know.
      onClickCapture={(e) => {
        if (!(e.target instanceof Element)) return;
        const anchor = e.target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement)) return;
        const cta = chatCtaIdFor(anchor);
        if (cta !== null) analytics.ctaClicked(cta);
      }}
    >
      {header !== undefined && <ChatHeader header={header} strings={strings} />}
      <Transcript
        plan={plan}
        strings={strings}
        theme={theme}
        mode={mode}
        surface={surface}
        {...(windowing !== undefined ? { window: windowing } : {})}
        {...(components !== undefined ? { components } : {})}
        onToggle={toggle}
        onRetry={handleRetry}
        onPromptAction={handlePromptAction}
        {...(onErrorAction !== undefined ? { onErrorAction } : {})}
        resolvedMounts={resolvedMounts}
        onViewPhase={onViewPhase}
        onViewDiagnosis={onViewDiagnosis}
        {...(onViewRef !== undefined ? { onViewRef } : {})}
        viewProps={effectiveViewProps}
        onStartNewConversation={startNewConversation}
      />
      {chips.length > 0 && inputs.messages.length === 0 && (
        <nav className="guuey-chat-chips-row" part={PARTS.chips} aria-label={strings.suggestionsLabel}>
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              className="guuey-chat-chip"
              part={PARTS.chip}
              onClick={() => sendSuggestion(chip)}
            >
              {chip}
            </button>
          ))}
        </nav>
      )}
      {showClearAffordance && inputs.messages.length > 0 && (
        <div className="guuey-chat-clear-row">
          <button
            type="button"
            className={`guuey-chat-clear${clearArmed ? " guuey-chat-clear-armed" : ""}`}
            onClick={() => {
              if (clearArmed) {
                setClearArmed(false);
                handle.clearConversation();
              } else {
                setClearArmed(true);
              }
            }}
          >
            {clearArmed ? strings.clearConversationConfirm : strings.clearConversationLabel}
          </button>
        </div>
      )}
      {pendingLink !== null && (
        <div role="status" className="guuey-chat-link-ask">
          <span className="guuey-chat-link-ask-label">
            {strings.linkAskLabel(new URL(pendingLink).host)}
          </span>
          <span className="guuey-chat-link-ask-url">{pendingLink}</span>
          <a
            className="guuey-chat-link-ask-open"
            href={pendingLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setPendingLink(null)}
          >
            {strings.linkOpen}
          </a>
          <button
            type="button"
            className="guuey-chat-link-ask-dismiss"
            onClick={() => setPendingLink(null)}
          >
            {strings.linkDismiss}
          </button>
        </div>
      )}
      {oauthReturn.notice !== null && (
        <p
          role="status"
          className={`guuey-chat-oauth-notice guuey-chat-oauth-${oauthReturnTone(oauthReturn.notice)}`}
        >
          {oauthReturnNoticeLine(oauthReturn.notice, strings)}
          <button type="button" className="guuey-chat-oauth-dismiss" onClick={oauthReturn.dismiss}>
            {strings.promptDismissed}
          </button>
        </p>
      )}
      {authRequired !== null && (
        <p role="status" className="guuey-chat-auth-required">
          <strong className="guuey-chat-auth-required-heading">
            {strings.authRequiredHeading(
              authRequired.servers.map((s) => s.label).join(", "),
            )}
          </strong>
          <span className="guuey-chat-auth-required-hint">{strings.authRequiredHint}</span>
        </p>
      )}
      {composer && (
      <form
        className="guuey-chat-composer"
        part={PARTS.composer}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {attachmentsEnabled && attachmentNotice !== null && (
          <p role="status" className="guuey-chat-attachment-notice">
            {attachmentNotice}
          </p>
        )}
        {attachmentsEnabled && pendingImages.length > 0 && (
          <ul className="guuey-chat-attachments" part={PARTS.attachments} aria-label={strings.attachmentsLabel}>
            {pendingImages.map((p) => (
              <li key={p.id} className="guuey-chat-attachment">
                <img className="guuey-chat-attachment-preview" src={p.previewUrl} alt={p.name} />
                <button
                  type="button"
                  className="guuey-chat-attachment-remove"
                  aria-label={strings.removeAttachment(p.name)}
                  onClick={() => removePendingImage(p.id)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {attachmentsEnabled && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={ATTACHMENT_ACCEPT}
              multiple
              hidden
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // Cleared so picking the same file again fires a change.
                e.target.value = "";
                void addImageFiles(files);
              }}
            />
            <button
              type="button"
              className="guuey-chat-composer-attach"
              part={PARTS.composerAttach}
              aria-label={strings.attachImage}
              title={strings.attachImage}
              disabled={!available || authRequired !== null || threadClosed || pendingImages.length >= IMAGE_ATTACHMENTS_MAX_COUNT}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          id={composerId}
          name="message"
          className="guuey-chat-composer-input"
          part={PARTS.composerInput}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => analytics.opened()}
          onPaste={
            attachmentsEnabled
              ? (e) => {
                  // guuey#2293: pasted images join the previews; pasted text
                  // is left to the textarea (no preventDefault).
                  const files = Array.from(e.clipboardData.files);
                  if (files.length > 0) void addImageFiles(files);
                }
              : undefined
          }
          onKeyDown={(e) => {
            // `isComposing` guards IME input: an Enter that commits a
            // candidate must not also send the message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!available || authRequired !== null || threadClosed}
          aria-label={strings.composerLabel}
          placeholder={
            !available
              ? strings.composerUnavailable
              : authRequired !== null
                ? strings.composerAuthRequired
                : threadClosed
                  ? strings.composerThreadClosed
                  : waitingOnUser
                    ? strings.composerWaitingOnYou
                    : strings.composerPlaceholder
          }
        />
        {busy && !waitingOnUser ? (
          <button
            type="button"
            className="guuey-chat-composer-stop"
            part={PARTS.composerStop}
            onClick={() => invoke.abort()}
          >
            {strings.stop}
          </button>
        ) : (
          <button type="submit" className="guuey-chat-composer-send" part={PARTS.composerSend} disabled={!canSend}>
            {strings.send}
          </button>
        )}
      </form>
      )}
    </div>
  );
});
