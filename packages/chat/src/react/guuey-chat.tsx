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
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { createWebAdapters, type AgentInvokeAdapters } from "@guuey/agent-client";
import { useAgentInvoke } from "@guuey/agent-client/react";
import type { UiResourceReader } from "@guuey/mcp-apps-host";
import { calmPolicy, debugPolicy, type TranscriptPolicy } from "../policy.js";
import { defaultChatStrings, type ChatStrings } from "../strings.js";
import { DEFAULT_CHAT_THEME, type GuueyChatTheme } from "../theme.js";
import type { ErrorItem, PromptItem, UserMessageItem } from "../types.js";
import type { ThemeMode } from "./theme-css.js";
import { Transcript, type TranscriptWindowing } from "./transcript.js";
import type { TranscriptComponents, TranscriptItemContext } from "./components.js";
import { useTranscript, useTranscriptInputs } from "./use-transcript.js";

export interface GuueyChatProps {
  /** Pod base URL (with or without `/agent/invoke`). `null` disables chat. */
  endpointUrl: string | null;
  /** Owning app id — namespaces the persisted threadId. */
  appId?: string;
  /**
   * Host couplings (storage / id / transport / history). Default:
   * `createWebAdapters()` — localStorage thread persistence + the web SSE
   * transport (cookie/guest identity, saturation + cold-start retries).
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
  /** R6 locator resolution (history cards). See `useTranscript`. */
  reader?: UiResourceReader;
  /** R6 pass-through (relay hook, sandbox page/flags, host context…). */
  viewProps?: TranscriptItemContext["viewProps"];
  /**
   * R10: what accept/decline actually DO (the grant channel is the host's).
   * The transcript record moves regardless; without a handler the prompt
   * card is record-only.
   */
  onPromptAction?: (item: PromptItem, action: "accept" | "decline" | "dismiss") => void;
  /** R11 action slot (sign-in / retry affordances). */
  onErrorAction?: (item: ErrorItem) => void;
  className?: string;
  style?: CSSProperties;
}

const PROMPT_STATE = {
  accept: "answered",
  decline: "declined",
  dismiss: "dismissed",
} as const;

export function GuueyChat(props: GuueyChatProps): ReactNode {
  const {
    endpointUrl,
    appId,
    adapters: adaptersProp,
    preset = "calm",
    policy: policyOverrides,
    components,
    strings: stringOverrides,
    theme = DEFAULT_CHAT_THEME,
    mode = "light",
    window: windowing,
    reader,
    viewProps,
    onPromptAction,
    onErrorAction,
    className,
    style,
  } = props;

  const adapters = useMemo(() => adaptersProp ?? createWebAdapters(), [adaptersProp]);
  const invoke = useAgentInvoke({ endpointUrl, ...(appId !== undefined ? { appId } : {}), adapters, preserveBlocks: true });

  const policy = useMemo(() => {
    const factory = preset === "debug" ? debugPolicy : calmPolicy;
    const strings: ChatStrings = {
      ...defaultChatStrings,
      ...policyOverrides?.strings,
      ...stringOverrides,
    };
    return factory({ ...policyOverrides, strings });
  }, [preset, policyOverrides, stringOverrides]);

  const { inputs, resolvePrompt } = useTranscriptInputs(invoke);
  const { plan, toggle, resolvedMounts, onViewPhase } = useTranscript({
    inputs,
    policy,
    ...(reader !== undefined ? { reader } : {}),
  });

  // ── Composer ─────────────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const busy = invoke.status !== "ready";
  const available = endpointUrl !== null;
  const canSend = available && !busy && input.trim() !== "";

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
    (item: PromptItem, action: "accept" | "decline" | "dismiss") => {
      resolvePrompt(item.promptId, PROMPT_STATE[action]);
      onPromptAction?.(item, action);
    },
    [resolvePrompt, onPromptAction],
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
}
