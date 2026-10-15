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
 *    injected MCP App WebView host (`McpAppIframe`).
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
export type {
  NativeMcpAppFrameResource,
  NativeUiActionRelay,
} from "./native/view-host-logic.js";
export type {
  NativeTranscriptItemContext,
  NativeTranscriptItemProps,
} from "./native/components.js";
