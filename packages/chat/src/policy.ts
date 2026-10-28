/**
 * Presets as complete policy bundles (spec §5): `calm` (end-user, THE
 * default) and `debug` (builder) are exported policy VALUES, not modes
 * scattered through components. Every §3 knob lives here; the factories
 * take partial overrides so a builder tunes one knob without forfeiting the
 * rest of the preset.
 */
import { defaultChatStrings, humanizeToolName, type ChatStrings } from "./strings.js";
import { DEFAULT_MAX_INLINE_MEDIA_BYTES, DEFAULT_MEDIA_ORIGINS } from "./media.js";

export interface TranscriptPolicy {
  /** The i18n seam — override any string without forking components (§4.2). */
  strings: ChatStrings;
  /** Chrome locale (a view's own locale rides the wave-2 hostContext instead). */
  locale: string;
  /**
   * The debug master switch: raw-state suffixes on the status line, the
   * #192 recovered marker, verbatim wire errors, raw prompt payloads, and
   * R15's full pretty-printed payload all key off it.
   */
  debugDetail: boolean;
  /** R0. */
  userMessage: {
    retryAffordance: boolean;
    /**
     * Draw forwarded view-directive turns (guuey#422 `ui/message` relays
     * carrying `<ggui_directive>`) as ACTION turns (guuey#2031): the tapped
     * controls' words when the row carries them, else the calm
     * `strings.directiveContinuation` line. Display-only — the sent/
     * persisted text stays wire-verbatim. On in both presets; `false` is a
     * builder's explicit opt-out that draws the verbatim bubble instead.
     */
    collapseDirectives: boolean;
    /**
     * Offer the wire-verbatim directive in a quiet toggle BELOW an action
     * turn (guuey#2031). `false` in calm: machine text never reaches a
     * visitor, so the action turn and the continuation line have no
     * disclosure at all. `true` in debug (the builder surface).
     */
    rawDirective: boolean;
  };
  /** R1 (markdown sanitization itself is the 3b renderer's security surface). */
  text: { markdown: boolean };
  /** R2. */
  reasoning: { show: boolean; expandedByDefault: boolean };
  /** R3. */
  tool: {
    expandByDefault: boolean;
    argsVisible: boolean;
    humanizeTitle: (wireName: string) => string;
    /**
     * guuey#1279 — which tool rows render in the transcript. `"non-ggui"`
     * (default) filters ggui protocol/lifecycle rows (handshake/render/consume)
     * by construction while keeping the render card mount; `"all"` shows every
     * tool row (debug); `"none"` shows no tool rows. The wire is unchanged —
     * pods keep emitting tool events; this is render-side only.
     */
    showToolRows: "all" | "non-ggui" | "none";
  };
  /** R4 — `false` disables grouping entirely (debug's default). */
  toolGroup: { threshold: number | false };
  /** R5. */
  dataResult: {
    capRem: number;
    prettyPrint: boolean;
    alwaysShowBytes: boolean;
    /** Preview bound — the plan never carries a full giant payload (fixture 6). */
    previewChars: number;
  };
  /**
   * R6 (sandbox overrides pass through to `<GuueyView>` in 3b).
   * `presentation` (guuey#301): `"inline"` = every mount renders as a live
   * view in the transcript (the default, unchanged); `"chips"` = EVERY
   * view plans as a compact {@link ViewRefItem} — the full render belongs
   * to a host-owned stage fed by `TranscriptPlan.views` + the selection
   * input `promotedViewKey`.
   */
  view: { timeoutMs: number; presentation: "inline" | "chips" };
  /**
   * R7. `origins` and `maxInlineBytes` decide what the viewer's device may
   * load (guuey#2369, see `mediaDisplay`): `data:` / base64 bytes under the
   * cap, `blob:` URLs, and https URLs on `origins`; any other https URL is
   * a chip with an "open link" action, never fetched. `origins` entries are
   * exact https origins or `https://*.host` subdomain wildcards; the default
   * is the guuey media origin, and a host passes its own list to replace or
   * extend it (spread `DEFAULT_MEDIA_ORIGINS` to extend).
   */
  media: {
    inlineImageCapRem: number;
    chipOnly: boolean;
    origins: readonly string[];
    maxInlineBytes: number;
  };
  /** R8. */
  code: { capRem: number; wrap: boolean };
  /** R9. */
  citations: { style: "chips" | "list" };
  /** R10. */
  prompt: { placement: "inline" | "modal"; rawPayload: boolean };
  /**
   * R11. `copyByCode` is the specced per-code copy knob (the directive's
   * `errorCopy`, nested here so it doesn't stutter as `error.errorCopy`):
   * an exact wire-code → sentence map that wins over everything else.
   * `verbatimCodes` renders the SOURCE message instead of family copy for
   * the listed codes — or for every error (`"all"`, the widget's #162
   * posture: pod refusal bodies are already written for a reader, and
   * client-side identity copy arrives code-less). Precedence per error:
   * `copyByCode[code]` → verbatim source message (when matched and
   * non-empty) → family copy. `verbatim` stays the DEBUG formatting knob
   * (code-prefixed raw line under the notice), independent of voice.
   *
   * DEFAULT `verbatimCodes` is empty. `POD_SATURATED` (guuey#2604) and
   * `DRAINING` left it: both envelopes name internals (a turn cap, a pod
   * re-routing) and carry no timing a reader can use, so the defaults are the
   * plain `strings.errorPodSaturated` and `strings.errorDraining` lines. A
   * host's `copyByCode` still wins; a host that wants a pod's sentence back
   * lists the code (`verbatimCodes: ["DRAINING"]`), and `"all"` keeps every
   * source message (the widget's #162 posture), with no per-code exception:
   * a client code's source is the SDK's own sentence (`WAKE_TIMED_OUT`,
   * guuey#2453, carries `WAKE_TIMED_OUT_MESSAGE`, which is also
   * `strings.errorWakeTimedOut`'s default).
   */
  error: {
    verbatim: boolean;
    copyByCode: Readonly<Record<string, string>>;
    verbatimCodes: readonly string[] | "all";
  };
  /** R12 — thresholds are chosen-not-measured (§10-F6; 3b validates vs #188 data). */
  status: { wakingMs: number; longStartMs: number };
  /** R16 (spec draft.2) — notice rows; provenance facet shows under debug. */
  notice: { show: boolean };
  /** R14. */
  compaction: { show: boolean };
  /** R15. */
  unknown: { show: boolean; raw: boolean };
}

/** Deep-ish merge for the one level of nesting policies actually have. */
/**
 * Per-section partial overrides — the shape `withOverrides` actually
 * merges (each section spreads over its base), so the type tells the
 * truth: `{ view: { presentation: 'chips' } }` is valid without
 * restating the section's other fields (guuey#321 surfaced the lie).
 */
export type TranscriptPolicyOverrides = {
  [K in keyof TranscriptPolicy]?: Partial<TranscriptPolicy[K]>;
};

function withOverrides(base: TranscriptPolicy, overrides?: TranscriptPolicyOverrides): TranscriptPolicy {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    strings: { ...base.strings, ...(overrides.strings ?? {}) },
    userMessage: { ...base.userMessage, ...(overrides.userMessage ?? {}) },
    text: { ...base.text, ...(overrides.text ?? {}) },
    reasoning: { ...base.reasoning, ...(overrides.reasoning ?? {}) },
    tool: { ...base.tool, ...(overrides.tool ?? {}) },
    toolGroup: { ...base.toolGroup, ...(overrides.toolGroup ?? {}) },
    dataResult: { ...base.dataResult, ...(overrides.dataResult ?? {}) },
    view: { ...base.view, ...(overrides.view ?? {}) },
    media: { ...base.media, ...(overrides.media ?? {}) },
    code: { ...base.code, ...(overrides.code ?? {}) },
    citations: { ...base.citations, ...(overrides.citations ?? {}) },
    prompt: { ...base.prompt, ...(overrides.prompt ?? {}) },
    error: { ...base.error, ...(overrides.error ?? {}) },
    status: { ...base.status, ...(overrides.status ?? {}) },
    notice: { ...base.notice, ...(overrides.notice ?? {}) },
    compaction: { ...base.compaction, ...(overrides.compaction ?? {}) },
    unknown: { ...base.unknown, ...(overrides.unknown ?? {}) },
  };
}

function calmBase(): TranscriptPolicy {
  return {
    strings: defaultChatStrings,
    locale: "en",
    debugDetail: false,
    userMessage: { retryAffordance: true, collapseDirectives: true, rawDirective: false },
    text: { markdown: true },
    reasoning: { show: true, expandedByDefault: false },
    tool: { expandByDefault: false, argsVisible: false, humanizeTitle: humanizeToolName, showToolRows: "non-ggui" },
    toolGroup: { threshold: 2 },
    dataResult: { capRem: 16, prettyPrint: true, alwaysShowBytes: false, previewChars: 2048 },
    view: { timeoutMs: 8000, presentation: "inline" },
    media: {
      inlineImageCapRem: 20,
      chipOnly: false,
      origins: DEFAULT_MEDIA_ORIGINS,
      maxInlineBytes: DEFAULT_MAX_INLINE_MEDIA_BYTES,
    },
    code: { capRem: 16, wrap: false },
    citations: { style: "chips" },
    notice: { show: true },
    prompt: { placement: "inline", rawPayload: false },
    error: { verbatim: false, copyByCode: {}, verbatimCodes: DEFAULT_VERBATIM_CODES },
    status: { wakingMs: 2500, longStartMs: 15_000 },
    compaction: { show: true },
    unknown: { show: true, raw: false },
  };
}

/**
 * The refusal codes whose SOURCE message is the copy by default: none
 * (guuey#2604). `POD_SATURATED` reads `strings.errorPodSaturated` and
 * `DRAINING` reads `strings.errorDraining`, since neither pod envelope is
 * written for a visitor. Exported so a host can spread it into its own list
 * rather than retype it.
 */
export const DEFAULT_VERBATIM_CODES: readonly string[] = [];

/** The `calm` preset — the end-user default (spec §5). */
export function calmPolicy(overrides?: TranscriptPolicyOverrides): TranscriptPolicy {
  return withOverrides(calmBase(), overrides);
}

/** The `debug` preset — the builder surface (Studio's test chat, spec §5). */
export function debugPolicy(overrides?: TranscriptPolicyOverrides): TranscriptPolicy {
  const base = calmBase();
  const debug: TranscriptPolicy = {
    ...base,
    debugDetail: true,
    // guuey#2031: a tap is an action turn on every surface; the builder
    // surface keeps the raw directive one toggle away below it.
    userMessage: { ...base.userMessage, rawDirective: true },
    reasoning: { ...base.reasoning, expandedByDefault: true },
    tool: { ...base.tool, expandByDefault: true, argsVisible: true, showToolRows: "all" },
    toolGroup: { threshold: false },
    dataResult: { ...base.dataResult, capRem: 32, alwaysShowBytes: true },
    prompt: { ...base.prompt, rawPayload: true },
    error: { ...base.error, verbatim: true },
    unknown: { ...base.unknown, raw: true },
  };
  return withOverrides(debug, overrides);
}
