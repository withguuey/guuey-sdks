/**
 * React Native entry point (`@guuey/chat/native`) — the RN renderer over
 * the SAME headless view-model as `./react` (wave 3c, guuey#135).
 *
 * Zero duplication by construction: the view-model, policies, theme
 * schema, and strings are the root subpath's exports, and the
 * renderer-state hooks (`useTranscript`, `useTranscriptInputs`) are the
 * SAME modules the web kit uses — they are React-generic (no DOM), so both
 * arms share one implementation. Only the walk differs: RN primitives, the
 * inverted-list scroll contract, and the schema's native theme projection
 * (`resolveNativeTheme` — CSS custom properties are the web projection).
 *
 * The R6 default is the documented native default-gap: this tier ships
 * WITHOUT a WebView dependency, so `view` is a required override (a
 * labeled placeholder renders otherwise — never blank). See
 * `native/components.tsx`.
 *
 * `react` and `react-native` are OPTIONAL peers — the root subpath stays
 * importable everywhere; this arm loads only inside an RN runtime.
 */
export {
  NativeTranscript,
  type NativeTranscriptProps,
  type NativeTranscriptListProps,
} from "./native/transcript.js";
export {
  nativeTranscriptComponents,
  renderNativeItem,
  NativeUserMessage,
  NativeText,
  NativeReasoning,
  NativeTool,
  NativeToolGroup,
  NativeDataResult,
  NativeView,
  NativeMedia,
  NativeCode,
  NativeCitations,
  NativePrompt,
  NativeError,
  NativeHistoryBoundary,
  NativeCompaction,
  NativeUnknown,
  NativeStatus,
  type NativeTranscriptComponents,
  type NativeTranscriptItemContext,
} from "./native/components.js";
export { NativeMarkdown } from "./native/markdown.js";
export {
  resolveNativeTheme,
  type NativeChatTokens,
  type NativeThemeMode,
} from "./native/theme-native.js";
// The React-generic renderer-state owner + live assembler — shared with
// the web kit (one implementation, two walks).
export {
  useTranscript,
  useTranscriptInputs,
  type UseTranscriptArgs,
  type UseTranscriptResult,
  type UseTranscriptInputsResult,
} from "./react/use-transcript.js";
