/**
 * React Native adapters (`@guuey/chat/native-adapters`) — what a native chat
 * needs beside `@guuey/chat/native`'s renderer:
 *
 *  - {@link createNativeAdapters} — the `useAgentInvoke` adapter bundle: the
 *    streaming invoke transport and the history read over an injected
 *    `fetch` (`expo/fetch`), the thread id in an injected async store
 *    (AsyncStorage);
 *  - {@link asyncStorageThreadStore} — that thread-id store on its own;
 *  - {@link createNativeViewHost} — a `view` slot that mounts cards in an
 *    injected MCP App WebView host (`McpAppIframe`);
 *  - {@link createMcpAppFrame} — that host, built from an injected
 *    react-native-webview `WebView` and answered by the same MCP Apps host
 *    machine as the web (guuey#3377).
 *  - {@link expoSpeechRecognizer} — composer dictation's engine for
 *    `useSpeechInput`, over an injected expo-speech-recognition module
 *    (guuey#2446).
 *
 * Every native module is INJECTED by the caller: this subpath adds no
 * dependency and no peer beyond `@guuey/chat/native`'s own. It loads only
 * inside a React Native runtime (the view host renders RN primitives).
 */
export {
  asyncStorageThreadStore,
  createNativeAdapters,
  type AsyncStorageThreadStoreOptions,
  type CreateNativeAdaptersOptions,
  type NativeKeyValueStorage,
} from "./native/adapters.js";
export {
  createNativeViewHost,
  type CreateNativeViewHostOptions,
  type NativeMcpAppFrameProps,
  type NativeViewHost,
} from "./native/view-host.js";
export {
  createMcpAppFrame,
  isInitialDocumentLoad,
  type CreateMcpAppFrameOptions,
  type McpAppWebView,
  type McpAppWebViewHandle,
  type McpAppWebViewLoadRequest,
  type McpAppWebViewMessageEvent,
  type McpAppWebViewProps,
} from "./native/mcp-app-frame/frame.js";
export {
  expoSpeechRecognizer,
  type ExpoSpeechEventMap,
  type ExpoSpeechRecognitionLike,
  type ExpoSpeechStartOptions,
  type ExpoSpeechSubscription,
} from "./native/speech.js";
export type {
  NativeMcpAppFrameResource,
  NativeUiActionRelay,
} from "./native/view-host-logic.js";
export type {
  NativeTranscriptItemContext,
  NativeTranscriptItemProps,
} from "./native/components.js";
