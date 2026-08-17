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
  planTranscript,
} from "./plan.js";
export {
  calmPolicy,
  debugPolicy,
  type TranscriptPolicy,
} from "./policy.js";
export {
  defaultChatStrings,
  humanizeToolName,
  type ChatStrings,
} from "./strings.js";
export { transcriptInputsFromHistory } from "./history-inputs.js";
export {
  buildHitlAnswer,
  grantModeDisplay,
  hitlPromptsFromFold,
  type HitlAnswerRecord,
  type HitlPromptAction,
} from "./hitl.js";
export {
  OAUTH_LINK_PARAMS,
  OAUTH_RETURN_PARAMS,
  OAUTH_SCHEME,
  oauthAuthorizeAsk,
  oauthAuthorizeHref,
  parseOAuthReturn,
  stripOAuthReturn,
  type OAuthAuthorizeAsk,
  type OAuthReturn,
} from "./oauth.js";
export {
  DEFAULT_CHAT_THEME,
  GUUEY_CHAT_THEME,
  GuueyChatPalette,
  GuueyChatTheme,
  resolveTheme,
} from "./theme.js";
export type {
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
  ProfilePromptInput,
  ProfilePromptItem,
  PromptItem,
  PromptItemInput,
  ReasoningItem,
  StatusLineItem,
  TextItem,
  ToolGroupItem,
  ToolItem,
  TranscriptInputs,
  TranscriptMessage,
  TranscriptOverrides,
  TranscriptPlan,
  UnknownItem,
  UserMessageItem,
  ViewMountItem,
  ViewRefItem,
} from "./types.js";
