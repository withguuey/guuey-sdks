/**
 * Presets as complete policy bundles (spec §5): `calm` (end-user, THE
 * default) and `debug` (builder) are exported policy VALUES, not modes
 * scattered through components. Every §3 knob lives here; the factories
 * take partial overrides so a builder tunes one knob without forfeiting the
 * rest of the preset.
 */
import { defaultChatStrings, humanizeToolName, type ChatStrings } from "./strings.js";

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
  userMessage: { retryAffordance: boolean };
  /** R1 (markdown sanitization itself is the 3b renderer's security surface). */
  text: { markdown: boolean };
  /** R2. */
  reasoning: { show: boolean; expandedByDefault: boolean };
  /** R3. */
  tool: {
    expandByDefault: boolean;
    argsVisible: boolean;
    humanizeTitle: (wireName: string) => string;
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
  /** R6 (sandbox overrides pass through to `<GuueyView>` in 3b). */
  view: { timeoutMs: number };
  /** R7. */
  media: { inlineImageCapRem: number; chipOnly: boolean };
  /** R8. */
  code: { capRem: number; wrap: boolean };
  /** R9. */
  citations: { style: "chips" | "list" };
  /** R10. */
  prompt: { placement: "inline" | "modal"; rawPayload: boolean };
  /** R11. */
  error: { verbatim: boolean };
  /** R12 — thresholds are chosen-not-measured (§10-F6; 3b validates vs #188 data). */
  status: { wakingMs: number; longStartMs: number };
  /** R14. */
  compaction: { show: boolean };
  /** R15. */
  unknown: { show: boolean; raw: boolean };
}

/** Deep-ish merge for the one level of nesting policies actually have. */
function withOverrides(base: TranscriptPolicy, overrides?: Partial<TranscriptPolicy>): TranscriptPolicy {
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
    compaction: { ...base.compaction, ...(overrides.compaction ?? {}) },
    unknown: { ...base.unknown, ...(overrides.unknown ?? {}) },
  };
}

function calmBase(): TranscriptPolicy {
  return {
    strings: defaultChatStrings,
    locale: "en",
    debugDetail: false,
    userMessage: { retryAffordance: true },
    text: { markdown: true },
    reasoning: { show: true, expandedByDefault: false },
    tool: { expandByDefault: false, argsVisible: false, humanizeTitle: humanizeToolName },
    toolGroup: { threshold: 2 },
    dataResult: { capRem: 16, prettyPrint: true, alwaysShowBytes: false, previewChars: 2048 },
    view: { timeoutMs: 8000 },
    media: { inlineImageCapRem: 20, chipOnly: false },
    code: { capRem: 16, wrap: false },
    citations: { style: "chips" },
    prompt: { placement: "inline", rawPayload: false },
    error: { verbatim: false },
    status: { wakingMs: 2500, longStartMs: 15_000 },
    compaction: { show: true },
    unknown: { show: true, raw: false },
  };
}

/** The `calm` preset — the end-user default (spec §5). */
export function calmPolicy(overrides?: Partial<TranscriptPolicy>): TranscriptPolicy {
  return withOverrides(calmBase(), overrides);
}

/** The `debug` preset — the builder surface (Studio's test chat, spec §5). */
export function debugPolicy(overrides?: Partial<TranscriptPolicy>): TranscriptPolicy {
  const base = calmBase();
  const debug: TranscriptPolicy = {
    ...base,
    debugDetail: true,
    reasoning: { ...base.reasoning, expandedByDefault: true },
    tool: { ...base.tool, expandByDefault: true, argsVisible: true },
    toolGroup: { threshold: false },
    dataResult: { ...base.dataResult, capRem: 32, alwaysShowBytes: true },
    prompt: { ...base.prompt, rawPayload: true },
    error: { verbatim: true },
    unknown: { ...base.unknown, raw: true },
  };
  return withOverrides(debug, overrides);
}
