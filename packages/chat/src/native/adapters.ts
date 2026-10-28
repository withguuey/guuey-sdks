/**
 * React Native host adapters for `useAgentInvoke` — the native counterpart of
 * `createWebAdapters`, and the same wire underneath.
 *
 * Nothing native is imported here: the streaming `fetch` and the key-value
 * storage are INJECTED by the caller (on Expo, `fetch` from `expo/fetch` and
 * `@react-native-async-storage/async-storage`), so this module adds no
 * dependency and no peer, and runs anywhere a test can run it.
 *
 * Why a streaming `fetch`: the pod streams each turn as SSE frames. React
 * Native's global `fetch` buffers the whole body, so a turn would sit on
 * "connecting" until its last byte. `expo/fetch` exposes the body as a
 * `ReadableStream`; the transport reads it incrementally and hands each
 * decoded chunk to the hook's parser as it arrives.
 */
import { createWebAdapters } from "@guuey/agent-client";
import type {
  AgentInvokeAdapters,
  CreateWebAdaptersOptions,
  GenerateId,
  ThreadIdStore,
} from "@guuey/agent-client";

/**
 * The slice of an async key-value store the thread store needs. AsyncStorage
 * satisfies it as is; so does any keychain or MMKV wrapper that returns
 * promises.
 */
export interface NativeKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Options for {@link asyncStorageThreadStore}. */
export interface AsyncStorageThreadStoreOptions {
  /**
   * Prepended to every key the hook asks for, so the thread ids sit in their
   * own namespace of a shared store. Default: none.
   */
  prefix?: string;
}

/**
 * Persist the thread id in an async key-value store (AsyncStorage).
 *
 * A failed write keeps the thread id in memory only — the same outcome as
 * the web store under blocked storage. The hook fires saves without awaiting
 * them (`void storage.save(…)`), so a rejected write would otherwise surface
 * as an unhandled rejection with no one to act on it. A failed READ is left
 * to reject: the hook already treats that as "nothing persisted".
 */
export function asyncStorageThreadStore(
  storage: NativeKeyValueStorage,
  opts: AsyncStorageThreadStoreOptions = {},
): ThreadIdStore {
  const prefix = opts.prefix ?? "";
  return {
    load: (key) => storage.getItem(prefix + key),
    save: (key, threadId) =>
      storage.setItem(prefix + key, threadId).then(
        () => undefined,
        () => undefined,
      ),
  };
}

/**
 * Options for {@link createNativeAdapters}. Every option shared with
 * `createWebAdapters` has the same name and the same meaning — read its docs
 * for the identity rules (one identity resolver per mode; a bearer always
 * wins over the guest secret; the two never travel together).
 */
export interface CreateNativeAdaptersOptions
  extends Pick<
    CreateWebAdaptersOptions,
    | "apiBaseUrl"
    | "getAccessToken"
    | "getGuestSecret"
    | "saturationAttempts"
    | "onSaturationWait"
    | "coldStartRetry"
    | "onWakeWait"
    | "allowedDomainsHint"
  > {
  /**
   * The `fetch` every request goes through — the invoke stream AND the
   * history read. Pass a streaming implementation (`fetch` from `expo/fetch`);
   * the platform global buffers the body, which stalls a turn until its end.
   */
  fetch: typeof fetch;
  /** Where the thread id persists (AsyncStorage, or anything of that shape). */
  storage: NativeKeyValueStorage;
  /** Forwarded to {@link AsyncStorageThreadStoreOptions.prefix}. */
  storagePrefix?: string;
  /**
   * Client-message id generator. Default: the web adapters' generator
   * (`crypto.randomUUID` where the runtime has it, a timestamped fallback
   * otherwise). Pass a UUID generator if the runtime lacks `crypto`.
   */
  generateId?: GenerateId;
}

/**
 * Build the React Native host-adapter bundle for `useAgentInvoke`.
 *
 * The transport and the history read are the web adapters' own (same
 * identity precedence, same retries, same history projection), pointed at the
 * injected `fetch`; the thread id persists through the injected storage. The
 * history adapter is installed exactly when the web adapters would install
 * it: an `apiBaseUrl` plus at least one identity resolver.
 */
export function createNativeAdapters(opts: CreateNativeAdaptersOptions): AgentInvokeAdapters {
  const base = createWebAdapters({
    fetchImpl: opts.fetch,
    ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
    ...(opts.getAccessToken !== undefined ? { getAccessToken: opts.getAccessToken } : {}),
    ...(opts.getGuestSecret !== undefined ? { getGuestSecret: opts.getGuestSecret } : {}),
    ...(opts.saturationAttempts !== undefined
      ? { saturationAttempts: opts.saturationAttempts }
      : {}),
    ...(opts.onSaturationWait !== undefined ? { onSaturationWait: opts.onSaturationWait } : {}),
    ...(opts.coldStartRetry !== undefined ? { coldStartRetry: opts.coldStartRetry } : {}),
    ...(opts.onWakeWait !== undefined ? { onWakeWait: opts.onWakeWait } : {}),
    ...(opts.allowedDomainsHint !== undefined
      ? { allowedDomainsHint: opts.allowedDomainsHint }
      : {}),
  });
  return {
    ...base,
    storage: asyncStorageThreadStore(opts.storage, {
      ...(opts.storagePrefix !== undefined ? { prefix: opts.storagePrefix } : {}),
    }),
    ...(opts.generateId !== undefined ? { generateId: opts.generateId } : {}),
  };
}
