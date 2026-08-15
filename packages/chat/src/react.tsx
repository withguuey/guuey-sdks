/**
 * React entry point (`@guuey/chat/react`) — the component kit over the
 * root subpath's headless view-model (wave 3b, guuey#135).
 *
 * The root subpath stays React-free forever; everything React-coupled —
 * the per-category components, `<Transcript>`, the renderer-state owner
 * (`useTranscript`), and the live input assembler (`useTranscriptInputs`)
 * — lives behind this arm, with `react` as an optional peer (the
 * mcp-apps-host precedent).
 *
 * Composition ladder (spec §1 "configurable"): use `<Transcript>` with the
 * default kit as-is → override per-category components → tune policy knobs
 * → drop to `planTranscript` + `attachViewHost` and render it all yourself.
 */
export {
  Transcript,
  type TranscriptProps,
  type TranscriptWindowing,
} from "./react/transcript.js";
export {
  defaultTranscriptComponents,
  renderItem,
  DefaultUserMessage,
  DefaultText,
  DefaultReasoning,
  DefaultTool,
  DefaultToolGroup,
  DefaultDataResult,
  DefaultView,
  DefaultViewRef,
  DefaultMedia,
  DefaultCode,
  DefaultCitations,
  DefaultPrompt,
  DefaultError,
  DefaultHistoryBoundary,
  DefaultCompaction,
  DefaultUnknown,
  DefaultStatus,
  type TranscriptComponents,
  type TranscriptItemContext,
  type ViewSlotProps,
} from "./react/components.js";
export {
  useTranscript,
  useTranscriptInputs,
  type UseTranscriptArgs,
  type UseTranscriptResult,
  type UseTranscriptInputsResult,
} from "./react/use-transcript.js";
export { GuueyChat, type GuueyChatProps } from "./react/guuey-chat.js";
export { Markdown } from "./react/markdown.js";
export { themeCssVars, type ThemeMode } from "./react/theme-css.js";
