/**
 * `<GuueyChat>` — the batteries-included surface (guuey#135 wave 3c): the
 * whole tier stack wired end to end, PLUS the composer (which arrives here
 * per the founder ruling — earlier tiers are transcript-only).
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
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  createUiResourceReader,
  createWebAdapters,
  type AgentInvokeAdapters,
} from "@guuey/agent-client";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import { useAgentInvoke } from "@guuey/agent-client/react";
import type { UiResourceReader } from "@guuey/mcp-apps-host";
import { calmPolicy, debugPolicy, type TranscriptPolicy } from "../policy.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import type { ChatDebugEvent, ErrorItem, PromptItem, UserMessageItem } from "../types.js";
import type { ThemeMode } from "./theme-css.js";
import { Transcript, type TranscriptWindowing } from "./transcript.js";
import type { TranscriptComponents, TranscriptItemContext } from "./components.js";
import { useTranscript, useTranscriptInputs } from "./use-transcript.js";

/**
 * The imperative seam (guuey#210): programmatic send/prefill/focus for
 * hosts that stay on the batteries-included path (suggested-prompt chips
 * being the filing use case). Reach it via `ref` or `onReady` — both
 * deliver the SAME stable object, valid for the component's whole life.
 */
export interface GuueyChatHandle {
  /**
   * Send `text` through exactly the Send button's gate: returns `false`
   * and does nothing when chat is unavailable (`endpointUrl === null`), a
   * turn is in flight, or the text is blank — it NEVER bypasses the
   * composer's rules. The typed draft is left untouched (a programmatic
   * send must not eat a half-typed message). Failures surface the same
   * way a composer send's do (the hook's `error` / R0 failed-send).
   */
  send(text: string): boolean;
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
}

export interface GuueyChatProps {
  /** Pod base URL (with or without `/agent/invoke`). `null` disables chat. */
  endpointUrl: string | null;
  /** Owning app id — namespaces the persisted threadId. */
  appId?: string;
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
   */
  getAccessToken?: (opts?: { forceRefresh?: boolean }) => Promise<string | null>;
  getGuestSecret?: () => string | null;
  /**
   * Host couplings (storage / id / transport / history). Default:
   * `createWebAdapters({ apiBaseUrl, getAccessToken, getGuestSecret })` —
   * localStorage thread persistence + the web SSE transport (cookie/guest
   * identity, saturation + cold-start retries), plus history when
   * `apiBaseUrl` is set.
   */
  adapters?: AgentInvokeAdapters;
  /** Policy preset (spec §5). Default `"calm"`. */
  preset?: "calm" | "debug";
  /** Knob overrides applied on top of the preset (spec §3's columns). */
  policy?: Partial<TranscriptPolicy>;
  /** Per-slot component overrides (spec §3's override column). */
  components?: Partial<TranscriptComponents>;
  /** String overrides — merged over the preset's `ChatStrings` (§4.2). */
  strings?: Partial<ChatStrings>;
  theme?: GuueyChatTheme;
  mode?: ThemeMode;
  /** DOM windowing (§3.2). `false` renders everything. */
  window?: TranscriptWindowing | false;
  /**
   * R6 locator resolution (history cards + meta-less live renders). See
   * `useTranscript`. Defaults from `apiBaseUrl` (+ `endpointUrl` for the
   * pod door) when omitted; an explicit reader always wins.
   */
  reader?: UiResourceReader;
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
  /** R11 action slot (sign-in / retry affordances). */
  onErrorAction?: (item: ErrorItem) => void;
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
  className?: string;
  style?: CSSProperties;
}

const PROMPT_STATE = {
  accept: "answered",
  decline: "declined",
  dismiss: "dismissed",
} as const;

export const GuueyChat = forwardRef<GuueyChatHandle, GuueyChatProps>(function GuueyChat(
  props: GuueyChatProps,
  ref,
): ReactNode {
  const {
    endpointUrl,
    appId,
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
    window: windowing,
    reader,
    onDebugEvent,
    viewProps,
    onPromptAction,
    onHitlAnswer,
    onErrorAction,
    onReady,
    onThread,
    className,
    style,
  } = props;

  const adapters = useMemo(
    () =>
      adaptersProp ??
      createWebAdapters({
        ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
        ...(getAccessToken !== undefined ? { getAccessToken } : {}),
        ...(getGuestSecret !== undefined ? { getGuestSecret } : {}),
      }),
    [adaptersProp, apiBaseUrl, getAccessToken, getGuestSecret],
  );
  const invoke = useAgentInvoke({ endpointUrl, ...(appId !== undefined ? { appId } : {}), adapters, preserveBlocks: true });

  // Default reader (guuey#221): built over the SAME identity as the
  // transport/history, targeting the pod door (live turns) then the
  // platform door (persisted). The threadId hydrates after mount and can
  // change on reset, so the reader is a stable function that reads the
  // CURRENT thread through a ref — `useTranscript` sees one reader for the
  // component's life and never re-resolves every mount on a thread flip.
  const threadIdRef = useRef<string | null>(invoke.threadId);
  threadIdRef.current = invoke.threadId;
  const defaultReader = useMemo<UiResourceReader | undefined>(() => {
    if (apiBaseUrl === undefined) return undefined;
    return async (resourceUri: string) => {
      const threadId = threadIdRef.current;
      // No thread yet ⇒ nothing persisted to scope a read to; a live-turn
      // locator always arrives with the thread already admitted (the
      // `session` frame precedes tool results).
      if (threadId === null) return undefined;
      // Assembled per read: `createUiResourceReader` is a cheap closure, and
      // the guest secret is re-resolved each call so a rotation takes
      // effect immediately — the same per-request property
      // `createWebAdapters` documents for its own resolvers.
      const read = createUiResourceReader({
        apiBaseUrl,
        threadId,
        endpointUrl,
        ...(getAccessToken !== undefined ? { getAccessToken } : {}),
        guestSecret: getGuestSecret ? getGuestSecret() : null,
      });
      return read(resourceUri);
    };
  }, [apiBaseUrl, endpointUrl, getAccessToken, getGuestSecret]);
  const effectiveReader = reader ?? defaultReader;

  const policy = useMemo(() => {
    const factory = preset === "debug" ? debugPolicy : calmPolicy;
    const strings: ChatStrings = {
      ...defaultChatStrings,
      ...policyOverrides?.strings,
      ...stringOverrides,
    };
    return factory({ ...policyOverrides, strings });
  }, [preset, policyOverrides, stringOverrides]);

  const { inputs, resolvePrompt, answerHitlPrompt } = useTranscriptInputs(invoke);
  const { plan, toggle, resolvedMounts, onViewPhase, onViewDiagnosis } = useTranscript({
    inputs,
    policy,
    ...(effectiveReader !== undefined ? { reader: effectiveReader } : {}),
    ...(onDebugEvent !== undefined ? { onDebugEvent } : {}),
  });

  // ── Composer ─────────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = invoke.status !== "ready";
  const available = endpointUrl !== null;
  const canSend = available && !busy && input.trim() !== "";

  // ── The imperative seam (guuey#210) ──────────────────────────────────
  // ONE stable handle for the component's whole life (hosts capture it in
  // `onReady` and keep it), reading live truth through a ref so a call
  // always sees the CURRENT gate — never a stale closure's.
  const liveRef = useRef({ available, busy, invoke, onReady });
  useEffect(() => {
    liveRef.current = { available, busy, invoke, onReady };
  });

  const handle = useMemo<GuueyChatHandle>(
    () => ({
      send: (text: string): boolean => {
        const live = liveRef.current;
        const trimmed = text.trim();
        // Exactly the Send button's gate — a handle send never bypasses it.
        if (!live.available || live.busy || trimmed === "") return false;
        void live.invoke.send(trimmed).catch(() => {
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
      // A getter, not a captured value: the handle is created once, but the
      // thread hydrates after mount and can change — reads go through the
      // same ref the default reader uses, so it is always the live id.
      get threadId(): string | null {
        return threadIdRef.current;
      },
    }),
    [],
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
    const text = input.trim();
    if (text === "" || !available || busy) return;
    setInput("");
    void invoke.send(text).catch(() => {
      // The hook surfaces the failure (`error` / R0 failed-send).
    });
  }, [input, available, busy, invoke]);

  const handleRetry = useCallback(
    (item: UserMessageItem) => {
      void invoke.send(item.text).catch(() => {
        // Same contract as submit: the hook owns failure surfacing.
      });
    },
    [invoke],
  );

  const handlePromptAction = useCallback(
    (item: PromptItem, action: "accept" | "decline" | "dismiss" | { grantModeId: string }) => {
      if (item.promptKind === "hitl") {
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
    [resolvePrompt, answerHitlPrompt, onHitlAnswer, onPromptAction],
  );

  const strings = policy.strings;

  return (
    <div
      className={`guuey-chat-surface${className !== undefined ? ` ${className}` : ""}`}
      style={style}
    >
      <Transcript
        plan={plan}
        strings={strings}
        theme={theme}
        mode={mode}
        {...(windowing !== undefined ? { window: windowing } : {})}
        {...(components !== undefined ? { components } : {})}
        onToggle={toggle}
        onRetry={handleRetry}
        onPromptAction={handlePromptAction}
        {...(onErrorAction !== undefined ? { onErrorAction } : {})}
        resolvedMounts={resolvedMounts}
        onViewPhase={onViewPhase}
        onViewDiagnosis={onViewDiagnosis}
        {...(viewProps !== undefined ? { viewProps } : {})}
      />
      <form
        className="guuey-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          className="guuey-chat-composer-input"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // `isComposing` guards IME input: an Enter that commits a
            // candidate must not also send the message.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!available}
          aria-label={strings.composerLabel}
          placeholder={available ? strings.composerPlaceholder : strings.composerUnavailable}
        />
        {busy ? (
          <button
            type="button"
            className="guuey-chat-composer-stop"
            onClick={() => invoke.abort()}
          >
            {strings.stop}
          </button>
        ) : (
          <button type="submit" className="guuey-chat-composer-send" disabled={!canSend}>
            {strings.send}
          </button>
        )}
      </form>
    </div>
  );
});
