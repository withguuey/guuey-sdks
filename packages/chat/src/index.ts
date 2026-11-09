/**
 * `@guuey/chat` — the default end-user transcript UI for guuey agents.
 *
 * Wave 3a (guuey#135): the HEADLESS half — `planTranscript` (the pure
 * view-model over the AgJSON fold + the invoke status surface), the
 * `calm`/`debug` policy presets, the `GuueyChatTheme` platform-data token
 * schema, and the `ChatStrings` i18n seam. Zero DOM, zero React.
 *
 * Wave 3b adds `./react` (the component kit + `<GuueyChat>` arrives in 3c);
 * this root subpath stays React-free forever — server-side transcript
 * rendering, tests, and RN bundlers consume the view-model directly.
 */
export {
  newestViewKey,
  planStatusLine,
  planTranscript,
  type StatusInputs,
} from "./plan.js";
// The retry rule a host's Retry calls is `retryInPlaceArgs` (guuey#2608): the
// turn's own arguments (`retrySendArgs`, guuey#2549) in the failed row's place.
export { retryInPlaceArgs, retrySendArgs } from "./retry.js";
export {
  calmPolicy,
  type TranscriptPolicyOverrides,
  debugPolicy,
  type TranscriptPolicy,
} from "./policy.js";
export {
  defaultChatStrings,
  humanizeToolName,
  type ChatStrings,
} from "./strings.js";
// guuey#2446 — composer dictation, the headless core: the engine contract an
// injected recognizer meets, its events, and the pure session reducer that
// `useSpeechInput` (at `./react` and `./native`) runs.
export {
  INITIAL_SPEECH_INPUT_STATE,
  joinSpeechText,
  speechInputReducer,
  speechSessionLive,
  speechSessionText,
  type SpeechErrorCode,
  type SpeechInputAction,
  type SpeechInputErrorCode,
  type SpeechInputState,
  type SpeechRecognizer,
  type SpeechRecognizerEvent,
  type SpeechSession,
  type SpeechStartOptions,
} from "./speech-input.js";
export { transcriptInputsFromHistory } from "./history-inputs.js";
export {
  DEFAULT_MAX_INLINE_MEDIA_BYTES,
  DEFAULT_MEDIA_ORIGINS,
  isMediaOrigin,
  mediaDisplay,
  type MediaChipReason,
  type MediaDisplay,
  type MediaLoadPolicy,
} from "./media.js";
export {
  HIGHLIGHT_MAX_CHARS,
  highlightCode,
  prettyJson,
  type HighlightKind,
  type HighlightToken,
} from "./highlight.js";
// guuey#2031 — the headless tap ledger: one entry per card tap, drawn before
// its turn is sent and closed by its sent row or a counts-only withdrawal.
export {
  createTapLedger,
  TAP_DOORBELL_GRACE_MS,
  TAP_RELAY_GRACE_MS,
  TAP_SENT_GRACE_MS,
  type ClaimedTap,
  type TapLedger,
  type TapLedgerMessage,
  type TapLedgerOptions,
} from "./tap-ledger.js";
export { isGguiConsumeTool, isWaitingOnUser } from "./listen.js";
export {
  buildHitlAnswer,
  grantModeDisplay,
  hitlAnswerChannel,
  hitlPromptsFromFold,
  MCP_OAUTH_ASK_PREFIX,
  PROFILE_CONSENT_ASK_PREFIX,
  type HitlAnswerChannel,
  type HitlAnswerRecord,
  type HitlPromptAction,
} from "./hitl.js";
export {
  OAUTH_LINK_PARAMS,
  OAUTH_RETRY_ERRORS,
  OAUTH_RETURN_PARAMS,
  OAUTH_SCHEME,
  OAUTH_UPFRONT_METADATA,
  authRequiredFromAsks,
  isNavigableUrl,
  oauthAuthorizeAsk,
  oauthAuthorizeHref,
  oauthReturnNoticeLine,
  oauthReturnTone,
  parseOAuthReturn,
  stripOAuthReturn,
  type AuthRequired,
  type AuthRequiredServer,
  type OAuthAuthorizeAsk,
  type OAuthReturn,
  type OAuthReturnNoticeStrings,
  type OAuthReturnTone,
} from "./oauth.js";
export {
  DEFAULT_CHAT_GLASS,
  DEFAULT_CHAT_SHADOW,
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
  GuueyChatFace,
  GuueyChatPalette,
  GuueyChatTheme,
  contrastRatio,
  CHIP_FACES,
  CUE_CONTRAST_FLOOR,
  paletteChipFace,
  paletteCue,
  parseOpaqueColor,
  resolveTheme,
  resolveCourtTheme,
} from "./theme.js";
export type { ChipFace, ChipFaceTokens, OpaqueRgb } from "./theme.js";
// guuey#1128: the host palette a guuey surface announces to every card
// (`hostContext.styles.variables`, the ggui#573 fallback layer) + the
// `hostContext.styles` composer both the kit and the widget mount through.
export {
  HOST_STYLE_VARIABLE_KEYS,
  hostContextStyles,
  hostStyleVariables,
  type HostStyleVariableKey,
  type HostStyleVariables,
} from "./host-style-variables.js";
export type {
  A2uiDebugEvent,
  A2uiItem,
  ChatDebugEvent,
  CitationsItem,
  CodeItem,
  CompactionItem,
  DataResultItem,
  DisplayItem,
  ErrorItem,
  HistoryBoundaryItem,
  ItemKey,
  HitlPromptInput,
  HitlPromptItem,
  MediaItem,
  NoticeItem,
  PendingTap,
  ProfilePromptInput,
  ProfilePromptItem,
  PromptItem,
  PromptItemInput,
  ReasoningItem,
  ConnectWait,
  SaturationWait,
  StatusLineItem,
  TapItem,
  TapWithdrawReason,
  TextItem,
  ToolGroupItem,
  ToolItem,
  TranscriptInputs,
  TranscriptMessage,
  TranscriptOverrides,
  TranscriptPlan,
  ThreadClosedNotice,
  PlanViewSummary,
  UnknownItem,
  UserMessageItem,
  ViewMountItem,
  ViewRefItem,
} from "./types.js";
// guuey#2366: the tree an `a2ui` item carries, for a renderer drawing the kind
// (the validator itself is at `@guuey/chat/a2ui`).
export type {
  A2uiAction,
  A2uiBound,
  A2uiFieldSpec,
  A2uiJsonObject,
  A2uiNode,
  A2uiPathBinding,
} from "./a2ui/schema.js";
export type { A2uiImageDisplay, A2uiLink } from "./a2ui/url-policy.js";
// The inline chat's usage events (`<GuueyChat analytics>`): the vocabulary,
// the sink shapes, and the tracker a host composing its own surface reuses.
export {
  chatAnalyticsGui,
  chatCtaIdFor,
  createChatAnalytics,
  hostPosthogSink,
  resolveChatAnalytics,
  type ChatAnalytics,
  type ChatAnalyticsCtaClickedProps,
  type ChatAnalyticsEventMap,
  type ChatAnalyticsEventName,
  type ChatAnalyticsGui,
  type ChatAnalyticsMessageSentProps,
  type ChatAnalyticsOpenedProps,
  type ChatAnalyticsOptions,
  type ChatAnalyticsProps,
  type ChatAnalyticsSetting,
  type ChatAnalyticsSink,
} from "./analytics.js";

// guuey#2554: the transcript scroll API, one definition for every transcript component (web now, native next, guuey#2569).
export type {
  TranscriptFollow,
  TranscriptHandleRef,
  TranscriptScrollHandle,
  TranscriptScrollOptions,
  TranscriptScrollProps,
  TranscriptScrollToItemOptions,
} from "./transcript-scroll.js";
