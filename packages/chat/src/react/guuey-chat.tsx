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
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  createUiActionRelay,
  createUiResourceReader,
  createWebAdapters,
  type AgentInvokeAdapters,
} from "@guuey/agent-client";
import type { AgHitlAnswer, AgPausedAsk } from "@silverprotocol/core";
import { useAgentInvoke } from "@guuey/agent-client/react";
import { unavailableToolCallResult } from "@guuey/mcp-apps-host";
import type { McpToolCallResult, UiActionRequest, UiResourceReader } from "@guuey/mcp-apps-host";
import { calmPolicy, debugPolicy, type TranscriptPolicyOverrides } from "../policy.js";
import { useStructuralIdentity } from "./structural-identity.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import type {
  ChatDebugEvent,
  ErrorItem,
  PlanViewSummary,
  PromptItem,
  UserMessageItem,
  ViewRefItem,
} from "../types.js";
import type { ThemeMode } from "./theme-css.js";
import { Transcript, type TranscriptWindowing } from "./transcript.js";
import type { TranscriptComponents, TranscriptItemContext, ViewSlotProps } from "./components.js";
import { useTranscript, useTranscriptInputs } from "./use-transcript.js";
import { oauthPromptAction, useOAuthReturn } from "./oauth-return.js";

/**
 * The kit-tier theme announce (guuey#302): default `hostContext.theme`
 * from the transcript mode onto every view slot. A caller-declared
 * `hostContext` key wins field-by-field; `theme` is only filled in.
 * Exported for tests; not part of the package surface.
 */
export function viewPropsWithThemeAnnounce(
  viewProps: TranscriptItemContext["viewProps"],
  mode: ThemeMode,
  defaults: Pick<ViewSlotProps, "onCallTool" | "onUpdateModelContext" | "onUserMessage"> = {},
): TranscriptItemContext["viewProps"] {
  const themed = (base: ViewSlotProps | undefined): ViewSlotProps => ({
    // Kit-default host wires (guuey#335): the ACTION RELAY (Confirm inside
    // a rendered card is a tools/call — without a relay the initialize-only
    // host -32601s and the interaction visibly fails) and the
    // model-context sink (a COMPLEMENT channel — producers mirror the
    // snapshot server-side, so a recording sink is honest). A caller-
    // declared slot prop always wins.
    ...defaults,
    ...base,
    hostContext: { theme: mode, ...base?.hostContext },
  });
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
    promotedViewKey,
    onViewRef,
    onViewsChange,
    onPromptAction,
    onHitlAnswer,
    oauthReturnTo,
    onOAuthAuthorize,
    onErrorAction,
    onReady,
    onThread,
    className,
    style,
  } = props;

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
  const getGuestSecretRef = useRef(getGuestSecret);
  getGuestSecretRef.current = getGuestSecret;
  const hasAccessToken = getAccessToken !== undefined;
  const hasGuestSecret = getGuestSecret !== undefined;

  const adapters = useMemo(
    () =>
      adaptersProp ??
      createWebAdapters({
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
    [adaptersProp, apiBaseUrl, hasAccessToken, hasGuestSecret],
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
      // Getters read through the refs at CALL time — the reader's identity
      // survives a host re-render handing in fresh arrows, and a rotated
      // getter takes effect on the next read (the same per-request property
      // `createWebAdapters` documents).
      const getToken = getAccessTokenRef.current;
      const getGuest = getGuestSecretRef.current;
      const read = createUiResourceReader({
        apiBaseUrl,
        threadId,
        endpointUrl,
        ...(getToken !== undefined ? { getAccessToken: getToken } : {}),
        guestSecret: getGuest !== undefined ? getGuest() : null,
      });
      return read(resourceUri);
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
  // Memoized: once a chip is selected (`promotedViewKey` set) this object
  // is on the plan's identity path — a per-render fresh spread here was the
  // second leg of the render loop the template surfaced.
  const transcriptInputs = useMemo(
    () => (promotedViewKey !== undefined ? { ...inputs, promotedViewKey } : inputs),
    [inputs, promotedViewKey],
  );
  const { plan, toggle, resolvedMounts, onViewPhase, onViewDiagnosis } = useTranscript({
    inputs: transcriptInputs,
    policy,
    ...(effectiveReader !== undefined ? { reader: effectiveReader } : {}),
    ...(onDebugEvent !== undefined ? { onDebugEvent } : {}),
  });

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

  // The DEFAULT ACTION RELAY (guuey#335 — the founder-hit Confirm bug):
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
  // (withActionStaging) for hosts that choose the composer-staging UX —
  // the widget's own mountCallTool still applies it by its own choice.
  const stagedDefaultOnCallTool = defaultOnCallTool;

  // The ui/message sink (guuey#422): the view hands the host role-user
  // content (ggui's #440 doorbell — the model directive that drains a
  // post-turn gesture). Forward through the SAME gate as handle.send: a
  // real turn starts, the agent calls ggui_consume, the card repaints.
  // Busy/unavailable ⇒ dropped (the doorbell fires post-turn by design;
  // mid-turn the consume pipe is live and no doorbell fires).
  const defaultOnUserMessage = useCallback((params: { [key: string]: unknown }) => {
    const content = params["content"];
    if (!Array.isArray(content)) return;
    const text = content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b && typeof b.text === "string"
          ? b.text
          : "",
      )
      .filter((t) => t !== "")
      .join("\n");
    if (text.trim() === "") return;
    const live = liveRef.current;
    if (!live.available || live.busy) return;
    void live.invoke.send(text).catch(() => {
      // The hook owns failure surfacing, same as every send path.
    });
  }, []);

  const effectiveViewProps = useMemo<TranscriptItemContext["viewProps"]>(
    () =>
      viewPropsWithThemeAnnounce(viewProps, mode, {
        ...(stagedDefaultOnCallTool !== undefined ? { onCallTool: stagedDefaultOnCallTool } : {}),
        onUpdateModelContext: defaultOnUpdateModelContext,
        onUserMessage: defaultOnUserMessage,
      }),
    [viewProps, mode, stagedDefaultOnCallTool, defaultOnUpdateModelContext, defaultOnUserMessage],
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
          ...(stagedDefaultOnCallTool !== undefined ? { onCallTool: stagedDefaultOnCallTool } : {}),
          onUpdateModelContext: defaultOnUpdateModelContext,
          onUserMessage: defaultOnUserMessage,
          hostContext: { theme: mode },
        }
      : (effectiveViewProps ?? {});

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
      // Same live-read discipline as `threadId`: the ref always holds the
      // CURRENT kit wiring (guuey#335 — the canvas-host door).
      viewSlotProps: (): ViewSlotProps => staticSlotPropsRef.current,
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

  // guuey#178: the broker's return notice (`?connected=` / `?error=`), read
  // + stripped off the address bar once on mount.
  const oauthReturn = useOAuthReturn();

  const handlePromptAction = useCallback(
    (item: PromptItem, action: "accept" | "decline" | "dismiss" | { grantModeId: string }) => {
      if (item.promptKind === "hitl") {
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
        {...(onViewRef !== undefined ? { onViewRef } : {})}
        viewProps={effectiveViewProps}
      />
      {oauthReturn.notice !== null && (
        <p
          role="status"
          className={`guuey-chat-oauth-notice guuey-chat-oauth-${oauthReturn.notice.kind}`}
        >
          {oauthReturn.notice.kind === "connected"
            ? strings.oauthConnected(oauthReturn.notice.serverName)
            : strings.oauthFailed(oauthReturn.notice.reason)}
          <button type="button" className="guuey-chat-oauth-dismiss" onClick={oauthReturn.dismiss}>
            {strings.promptDismissed}
          </button>
        </p>
      )}
      <form
        className="guuey-chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          id={composerId}
          name="message"
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
