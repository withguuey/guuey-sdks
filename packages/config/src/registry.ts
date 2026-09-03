/**
 * Model + framework registry — single source of truth per the model-release
 * playbook §8 item A; a release = one entry change here + rate-card row.
 */

export type ModelStatus = "ga" | "preview" | "announced" | "deprecated";

export interface ModelEntry {
  readonly id: string; // provider-native model id ("claude-sonnet-5")
  readonly provider: "anthropic" | "openai" | "google" | "openrouter";
  readonly label: string; // picker label ("Claude Sonnet 5")
  readonly status: ModelStatus; // 'announced' = known, NOT invocable on our org yet
  readonly isDefault?: true; // at most one per provider
  readonly sunset?: string; // ISO date, deprecated only
  /**
   * The picker's FRONT SLICE. `lineup` entries are what a model picker shows
   * without asking; every other invocable entry is reachable only behind the
   * picker's "See all models" door (founder ruling 2026-09-02, guuey#635:
   * "let's provide there 'see all models' and put fable5 there").
   *
   * This is a CURATION flag, not a claim about a model's provider lifecycle —
   * a non-`lineup` model is still Active, still served, still selectable. The
   * lifecycle lives in `status`/`sunset`, and Anthropic's own deprecations
   * page is the authority there (claude-fable-5 is Active with no deprecation
   * date, so it stays `ga` and merely moves behind the door).
   *
   * Anthropic's lineup is the current generation as of the 2026-09-02 wave
   * (Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5 — the same four ggui pins, one
   * vocabulary across both fleets). OpenAI's and Google's stay deliberately
   * curated to their newest two, which is exactly the set those providers
   * showed before the door existed — the door widened what is REACHABLE, it
   * did not change what is shown up front.
   */
  readonly lineup?: true;
}

export interface FrameworkEntry {
  readonly framework: "claude-agent-sdk" | "openai-agents-sdk" | "google-adk" | "vanilla";
  readonly sdkPackage: string | null; // npm name; python pkg for adk; null for vanilla
  readonly platformPinnedVersion: string | null; // what the fat image ships
  readonly facetSupportedRange: string | null; // silverprotocol facet peer range
  readonly defaultProvider: "anthropic" | "openai" | "google";
}

/**
 * Array order is picker order AFTER `modelsForProvider` floats the default to
 * the front.
 *
 * WHAT a picker shows up front is `lineup`, not a positional slice: the
 * platform's app-behavior picker renders `lineupForProvider` and puts
 * `legacyForProvider` behind a "See all models" door (guuey#637). Before that
 * door, the picker took google + openai's front slice with `.slice(0, 2)`, so
 * the second array entry per provider was product-visible by POSITION — that
 * is now carried by the flag instead, and array order only orders within each
 * half. Both halves are pinned by
 * `apps/platform/.../ModelSection/ModelSection.test.ts`.
 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5", status: "ga", isDefault: true, lineup: true },
  // guuey#635 (2026-09-02 wave): id verified against
  // platform.claude.com/docs/en/models/overview — never hand-typed.
  // `announced` = known, NOT invocable on our runtime yet (the registry's own
  // vocabulary): the model gate is the Claude Code binary — 2.1.247 in the
  // fat image 400s ("version 2.1.251 or newer is required", infra's dev turn
  // on guuey#638). Flips to `ga` in the cut after #659's image rolls to prod
  // (SDK 0.3.258 → binary ≥ 2.1.251). Pickers exclude it until then: an
  // announced row is in NEITHER picker half (`lineupForProvider` /
  // `legacyForProvider` partition the ga|preview allowlist). THE GA FLIP IS
  // TWO FIELDS: `status: "ga"` AND `lineup: true` — the marker is withheld
  // here only because `lineup` ⇒ invocable is a pinned invariant
  // (registry.test.ts), and it belongs to the front slice the moment the
  // model is invocable (guuey#637 step 2).
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", status: "announced" },
  // Stays `ga` on purpose: the deprecations page (read 2026-09-02) lists
  // claude-fable-5 as Active, Deprecated: N/A, tentative retirement "Not
  // sooner than June 9, 2027". `sunset` is an ISO date for DEPRECATED
  // entries; a not-sooner-than floor is not one. Flip only on a real
  // deprecation notice, quoting the page.
  //
  // Superseded by Fable 5.1, so it is NOT in the lineup — the founder's
  // 2026-09-02 ruling put it behind the picker's "See all models" door rather
  // than hiding it: apps already pinned to Fable 5 keep their edit flow,
  // because the door's expanded list carries their value.
  { id: "claude-fable-5", provider: "anthropic", label: "Claude Fable 5", status: "ga" },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", status: "ga", lineup: true },
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", status: "ga" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", status: "ga", lineup: true },
  // Superseded by Opus 5 at the same published price — behind the door.
  { id: "claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8", status: "ga" },
  // Terra — guuey's OpenAI default (founder call 2026-07-25). This DELIBERATELY
  // diverges from OpenAI's own `gpt-5.6` alias, which routes to Sol: Terra is
  // half Sol's price and the better cost/balance pick for hosted agent
  // workloads. The bare `gpt-5.6` alias is intentionally NOT a registry id
  // (never offered in a picker) — the rate card still rows it at Sol's price so
  // an alias call from BYO config can't under-meter.
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra", status: "ga", isDefault: true, lineup: true },
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol", status: "ga", lineup: true },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna", status: "ga" },
  { id: "gpt-5.5", provider: "openai", label: "GPT-5.5", status: "ga" },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", status: "ga" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", status: "ga" },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o Mini", status: "ga" },
  { id: "gemini-3.6-flash", provider: "google", label: "Gemini 3.6 Flash", status: "ga", isDefault: true, lineup: true },
  { id: "gemini-3.5-flash-lite", provider: "google", label: "Gemini 3.5 Flash Lite", status: "ga", lineup: true },
  { id: "gemini-3.5-flash", provider: "google", label: "Gemini 3.5 Flash", status: "ga" },
  { id: "gemini-3.1-pro", provider: "google", label: "Gemini 3.1 Pro", status: "ga" },
  { id: "gemini-2.5-flash", provider: "google", label: "Gemini 2.5 Flash", status: "ga" },
  { id: "gemini-2.5-pro", provider: "google", label: "Gemini 2.5 Pro", status: "ga" },
];

export const FRAMEWORK_REGISTRY: readonly FrameworkEntry[] = [
  {
    framework: "claude-agent-sdk",
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    // platformPinnedVersion = what the fat image ships. Guarded twice
    // (guuey#648/#653): scripts/check-pin-coherence.mjs (CI + pre-push,
    // the whole host-shared==registry==image==host==facet-peer chain) and
    // registry.pins.test.ts (always-on vs @guuey/host — the publish-time
    // belt that also runs where the root script does not exist).
    platformPinnedVersion: "0.3.258",
    facetSupportedRange: ">=0.2.76 <0.4",
    defaultProvider: "anthropic",
  },
  {
    framework: "openai-agents-sdk",
    sdkPackage: "@openai/agents",
    platformPinnedVersion: "0.17.0",
    facetSupportedRange: ">=0.2.0 <0.18",
    defaultProvider: "openai",
  },
  {
    framework: "google-adk",
    sdkPackage: "@google/adk", // the OFFICIAL JS ADK (the Python lane retired with guuey_adk_host)
    platformPinnedVersion: "1.6.0", // pinned in @guuey-private/host-shared (guuey#659 rails; 1.x line — the 2.0 migration is #657)
    facetSupportedRange: ">=1.0.0 <3", // @silverprotocol/google-adk@0.5.4 peer range (ADK 2.x admitted; the 1.x image pin short of 2.0 is a deliberate HOLD, guuey#657)
    defaultProvider: "google",
  },
  {
    framework: "vanilla",
    sdkPackage: null,
    platformPinnedVersion: null,
    facetSupportedRange: null,
    defaultProvider: "anthropic",
  },
];

/**
 * Get all models for a provider, filtered to ga|preview only, with default first.
 */
export function modelsForProvider(p: ModelEntry["provider"]): readonly ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.provider === p && (m.status === "ga" || m.status === "preview")).sort(
    (a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return 0;
    },
  );
}

/**
 * The picker's FRONT SLICE for a provider — the `lineup` half of
 * `modelsForProvider`, default first (guuey#637).
 *
 * Together with {@link legacyForProvider} this PARTITIONS `modelsForProvider`:
 * every invocable model appears in exactly one half, so a picker built from
 * both can never silently drop a model the way a positional `.slice()` could.
 */
export function lineupForProvider(p: ModelEntry["provider"]): readonly ModelEntry[] {
  return modelsForProvider(p).filter((m) => m.lineup === true);
}

/**
 * The other half — invocable models NOT in the front slice, in registry order.
 * These are what the picker's "See all models" door reveals: still Active,
 * still selectable, just superseded (Claude Fable 5, Sonnet 4.6, Opus 4.8 and
 * the older Gemini/GPT rows as of the 2026-09-02 wave).
 */
export function legacyForProvider(p: ModelEntry["provider"]): readonly ModelEntry[] {
  return modelsForProvider(p).filter((m) => m.lineup !== true);
}

/**
 * Get the default model id for a framework's default provider.
 */
export function defaultModelFor(framework: FrameworkEntry["framework"]): string {
  const fw = FRAMEWORK_REGISTRY.find((f) => f.framework === framework);
  if (!fw) throw new Error(`Unknown framework: ${framework}`);
  const model = MODEL_REGISTRY.find((m) => m.provider === fw.defaultProvider && m.isDefault && m.status === "ga");
  if (!model) throw new Error(`No default ga model for provider: ${fw.defaultProvider}`);
  return model.id;
}

/**
 * Look up a model entry by id.
 */
export function modelEntry(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}
