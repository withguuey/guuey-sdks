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
   * Each provider's lineup is the founder's pick, PER FLEET. guuey's today:
   * Anthropic's current generation as of the 2026-09-02 wave (Sonnet 5,
   * Fable 5.1, Opus 5, Haiku 4.5); OpenAI's his #1608 pick (d), guuey#1622
   * (Terra · GPT-6 Sol · Astra · GPT-6 Luna); Google's its current Flash line
   * (3.6 Flash, 3.8 Flash, 3.5 Flash Lite). The door widened what is
   * REACHABLE; it did not change what is shown up front.
   *
   * ONE VOCABULARY across both fleets (guuey and ggui) means the same model
   * NAMES and TIERS — an id names the same model, priced and classified the
   * same way, on either side. It does NOT mean the same front page: each
   * fleet's lineup is his per-fleet pick. The fleets differ on the OpenAI
   * front page by his choice ("Keep ggui at GPT-6 Luna only", guuey#1622
   * c.5786165228), and the Claude side converges after ggui#1266.
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
  // `ga` + `lineup` since 2026-09-08 (guuey#634 / #659): the model gate is
  // the Claude Code binary — 2.1.247 in the fat image 400'd the id ("version
  // 2.1.251 or newer is required", infra's dev turn on guuey#638); the image
  // now pins `@anthropic-ai/claude-agent-sdk` 0.3.282 exactly, whose bundled
  // `claude-agent-sdk-linux-x64@0.3.282` carries VERSION 2.1.282 ≥ 2.1.251
  // (read off the binary, guuey#1807). 0.3.280 (Claude Code v2.1.280) was the
  // first build the API admits for claude-opus-5-5, whose server floor is
  // 2.1.280; guuey#1607.
  // (infra's #659 read of the served image's build inputs, 2026-09-07) and
  // the id answered on dev on 2.1.258 (guuey#638). The flip is the TWO
  // fields at once — `status: "ga"` AND `lineup: true` — because `lineup`
  // ⇒ invocable is a pinned invariant (registry.test.ts) and the current
  // generation belongs to the picker's front slice (guuey#637 step 2). The
  // `announced` state this row wore for a week is still exercised: the
  // registry tests bind the same predicates over a synthetic announced row
  // (`bindRegistry`, below), so the fail-closed rules cannot rot while no
  // live row is announced.
  { id: "claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", status: "ga", lineup: true },
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
  // Opus 5.5 — GA (guuey#1623, the second stage of the staged Opus 5.5 arrival,
  // guuey#1608). It was `announced` (known, priced at list by #1621, not
  // pickable) until its preconditions served: claude-agent-sdk
  // 0.3.280 (#1607; Claude Code 2.1.280+ is Anthropic's client floor for it), and
  // the pin-8 guard that never sends `thinking: disabled` for it. That guard
  // matters because the model REFUSES a forced tool_choice ("tool_choice: type
  // \"tool\" and \"any\" are not supported for this model.",
  // req_011CfK595wXzVWNcN1A6Y9MV), which the #1183 first-impression arm sends, so
  // that arm SKIPS for it (`FIRST_IMPRESSION_SKIPPED {reason:'thinking'}`).
  // The lineup decision (guuey#1608 (d)): Opus 5.5 joins the Claude lineup, and
  // Opus 5 moves behind the "See all models" door (still ga, still selectable;
  // apps pinned to it keep their edit flow). The default stays Sonnet 5 (#1608 (b)).
  { id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", status: "ga", lineup: true },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5", status: "ga" },
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
  // guuey#798 / #802 (2026-09-05 wave): id verified against
  // developers.openai.com/api/docs/models/gpt-6-astra (fetched 2026-09-05
  // 00:45Z — the only snapshot listed, no dated id). `announced` = known, NOT
  // invocable on our runtime until #801's receipted call from a dev pod; the
  // status alone keeps it out of BOTH picker halves. Flips to `ga` (+ lineup
  // decision) in the first cut after its receipt (oss #806).
  { id: "gpt-5.6-terra", provider: "openai", label: "GPT-5.6 Terra", status: "ga", lineup: true },
  // GPT-6 Sol + GPT-6 Luna (guuey#1622 — his #1608 picks (a) "Staged: Sol+Luna
  // now, Opus 5.5 announced (Recommended)" and (d) "Successors in; Opus 5 + 5.6
  // Sol behind the door"): `ga` on QA's receipted in-pod calls (dev, 2026-09-22
  // 20:00Z, through the openai egress arm with the managed key: HTTP 200 on
  // /v1/responses, the provider echoed each id, usage in 11 / out 5 — #1606
  // c.5783217245). Priced at list, 272K tier included (#1621). The OpenAI
  // lineup is (d)'s order — Terra · GPT-6 Sol · Astra · GPT-6 Luna — and the
  // picker shows lineup rows in registry order, so the ROW ORDER here is the
  // ruling. Terra stays the default (#1624 is the gated default move).
  { id: "gpt-6-sol", provider: "openai", label: "GPT-6 Sol", status: "ga", lineup: true },
  // FLIPPED to ga 2026-09-05 on #801's receipted pod call (dev, through the
  // openai egress arm with the managed key: HTTP 200 on /v1/responses, the
  // provider echoed "gpt-6-astra", usage in 11 / out 5). In the lineup as a
  // non-default member (beside 5.6 Sol then; GPT-6 Sol since #1622) — Terra stays the default (founder's
  // cost/balance call, 2026-07-25). Known metering gap stated on guuey#818:
  // prompts above 272K input tokens are vendor-priced at 2× and the card has
  // no context tier yet.
  { id: "gpt-6-astra", provider: "openai", label: "GPT-6 Astra", status: "ga", lineup: true },
  // The OpenAI default since guuey#1624 (his #1608 pick (c), "Move to GPT-6 Luna
  // (after the gates)"). The gates were the chip drafts' max_completion_tokens
  // (#1614) and a measured per-turn comparison against Terra on guuey's own
  // workloads (U6: 60 sessions, dev pin 23, pre-registered rules; Luna was not
  // worse on any criterion, and faster to the first card and cheaper per turn
  // by non-overlapping intervals). Being the default floats it to the front of
  // the lineup; the rest keep (d)'s order.
  { id: "gpt-6-luna", provider: "openai", label: "GPT-6 Luna", status: "ga", isDefault: true, lineup: true },
  // Superseded by GPT-6 Sol ((d) above): still ga, still served, still
  // selectable — behind the "See all models" door, beside 5.6 Luna.
  { id: "gpt-5.6-sol", provider: "openai", label: "GPT-5.6 Sol", status: "ga" },
  { id: "gpt-5.6-luna", provider: "openai", label: "GPT-5.6 Luna", status: "ga" },
  { id: "gpt-5.5", provider: "openai", label: "GPT-5.5", status: "ga" },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", status: "ga" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o", status: "ga" },
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o Mini", status: "ga" },
  { id: "gemini-3.6-flash", provider: "google", label: "Gemini 3.6 Flash", status: "ga", isDefault: true, lineup: true },
  // FLIPPED to ga 2026-09-05 on #801's receipted pod call (dev, through the
  // gemini egress arm with the managed key: HTTP 200 on
  // :streamGenerateContent?alt=sse, the provider echoed modelVersion
  // "gemini-3.8-flash", usageMetadata prompt 6 / candidates 1 / thoughts 42;
  // #804 closed on that payload). In the lineup as a non-default member after
  // 3.6 Flash — the default stays 3.6 (founder's 2026-07-25 price call; 3.8's
  // intro price ends 2026-12-31 and the card bills its standard rate).
  { id: "gemini-3.8-flash", provider: "google", label: "Gemini 3.8 Flash", status: "ga", lineup: true },
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
    platformPinnedVersion: "0.3.282",
    facetSupportedRange: ">=0.2.76 <0.4",
    defaultProvider: "anthropic",
  },
  {
    framework: "openai-agents-sdk",
    sdkPackage: "@openai/agents",
    platformPinnedVersion: "0.18.0",
    facetSupportedRange: ">=0.2.0 <0.19",
    defaultProvider: "openai",
  },
  {
    framework: "google-adk",
    sdkPackage: "@google/adk", // the OFFICIAL JS ADK (the Python lane retired with guuey_adk_host)
    platformPinnedVersion: "2.1.0", // pinned in @guuey-private/host-shared (guuey#659 rails; 2.x line since #657; 2.1.0 = W39 guuey#1581)
    facetSupportedRange: ">=1.0.0 <3", // @silverprotocol/google-adk@0.5.4+ peer range (ADK 2.x admitted; the host devDep, template and this pin moved to 2.0.0 in guuey#657; the runtime image (host-shared) follows on its own roll, guuey#657)
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
 * The registry's ACCESSORS, bound to an explicit registry (guuey#634).
 *
 * Every predicate below closes over the models it judges. The live exports
 * further down are `bindRegistry(MODEL_REGISTRY)` — the one registry this
 * package ships — and that is what every product door imports. The seam
 * exists for one reason: the fail-closed rules for a not-yet-invocable
 * (`announced`) row must stay exercised in the weeks when NO live row is
 * announced (the July 2026 wave left that branch untested once; the Fable
 * 5.1 flip on 2026-09-08 would have again). A test binds the same code
 * over `[...MODEL_REGISTRY, <synthetic announced row>]` and proves the
 * exclusion — same predicates, never a re-implementation that could drift.
 * It is NOT a runtime extension point: a consumer that bound its own
 * registry would be the second source of truth the registry exists to
 * prevent.
 */
export interface RegistryAccessors {
  /** All invocable (ga|preview) models for a provider, default first. */
  modelsForProvider(p: ModelEntry["provider"]): readonly ModelEntry[];
  /** The picker's front slice — the `lineup` half of `modelsForProvider`. */
  lineupForProvider(p: ModelEntry["provider"]): readonly ModelEntry[];
  /** The other half — invocable models behind the "See all models" door. */
  legacyForProvider(p: ModelEntry["provider"]): readonly ModelEntry[];
  /** A provider's `announced` rows — display only, invocable by nothing. */
  announcedForProvider(p: ModelEntry["provider"]): readonly ModelEntry[];
  /** A framework's model axis — its default provider's invocable rows. */
  modelsForFramework(framework: FrameworkEntry["framework"]): readonly ModelEntry[];
  /** THE offered / off-registry predicate, fail-closed (guuey#647). */
  isOfferedModel(framework: FrameworkEntry["framework"], id: string): boolean;
  /** The default model id for a framework's default provider. */
  defaultModelFor(framework: FrameworkEntry["framework"]): string;
  /** Look up a model entry by id. */
  modelEntry(id: string): ModelEntry | undefined;
}

export function bindRegistry(
  models: readonly ModelEntry[],
  frameworks: readonly FrameworkEntry[] = FRAMEWORK_REGISTRY,
): RegistryAccessors {
  const frameworkFor = (framework: FrameworkEntry["framework"]): FrameworkEntry => {
    const fw = frameworks.find((f) => f.framework === framework);
    if (!fw) throw new Error(`Unknown framework: ${framework}`);
    return fw;
  };
  const modelsForProvider: RegistryAccessors["modelsForProvider"] = (p) =>
    models
      .filter((m) => m.provider === p && (m.status === "ga" || m.status === "preview"))
      .sort((a, b) => {
        if (a.isDefault) return -1;
        if (b.isDefault) return 1;
        return 0;
      });
  const lineupForProvider: RegistryAccessors["lineupForProvider"] = (p) =>
    modelsForProvider(p).filter((m) => m.lineup === true);
  const legacyForProvider: RegistryAccessors["legacyForProvider"] = (p) =>
    modelsForProvider(p).filter((m) => m.lineup !== true);
  const announcedForProvider: RegistryAccessors["announcedForProvider"] = (p) =>
    models.filter((m) => m.provider === p && m.status === "announced");
  const modelsForFramework: RegistryAccessors["modelsForFramework"] = (framework) =>
    modelsForProvider(frameworkFor(framework).defaultProvider);
  const isOfferedModel: RegistryAccessors["isOfferedModel"] = (framework, id) =>
    modelsForFramework(framework).some((m) => m.id === id);
  const defaultModelFor: RegistryAccessors["defaultModelFor"] = (framework) => {
    const fw = frameworkFor(framework);
    const model = models.find((m) => m.provider === fw.defaultProvider && m.isDefault && m.status === "ga");
    if (!model) throw new Error(`No default ga model for provider: ${fw.defaultProvider}`);
    return model.id;
  };
  const modelEntry: RegistryAccessors["modelEntry"] = (id) => models.find((m) => m.id === id);
  return {
    modelsForProvider,
    lineupForProvider,
    legacyForProvider,
    announcedForProvider,
    modelsForFramework,
    isOfferedModel,
    defaultModelFor,
    modelEntry,
  };
}

/** The live registry, bound once — every export below reads THIS. */
const live = bindRegistry(MODEL_REGISTRY);

/**
 * Get all models for a provider, filtered to ga|preview only, with default first.
 */
export const modelsForProvider: RegistryAccessors["modelsForProvider"] = live.modelsForProvider;

/**
 * The picker's FRONT SLICE for a provider — the `lineup` half of
 * `modelsForProvider`, default first (guuey#637).
 *
 * Together with {@link legacyForProvider} this PARTITIONS `modelsForProvider`:
 * every invocable model appears in exactly one half, so a picker built from
 * both can never silently drop a model the way a positional `.slice()` could.
 */
export const lineupForProvider: RegistryAccessors["lineupForProvider"] = live.lineupForProvider;

/**
 * The other half — invocable models NOT in the front slice, in registry order.
 * These are what the picker's "See all models" door reveals: still Active,
 * still selectable, just superseded (Claude Fable 5, Sonnet 4.6, Opus 4.8 and
 * the older Gemini/GPT rows as of the 2026-09-02 wave).
 */
export const legacyForProvider: RegistryAccessors["legacyForProvider"] = live.legacyForProvider;

/**
 * A provider's ANNOUNCED rows, in registry order — models the registry knows
 * about that are NOT invocable on our runtime yet.
 *
 * This is a DISPLAY accessor and nothing more (guuey#805). It is deliberately
 * OUTSIDE the `lineupForProvider` / `legacyForProvider` partition and outside
 * every offer predicate: `modelsForProvider`, `modelsForFramework`,
 * `isOfferedModel` and `defaultModelFor` keep failing closed on an announced
 * id exactly as they did before this existed (guuey#647), and the server's
 * create validator stays the backstop. Its only job is to let a console tell
 * the truth about a model it can see but cannot run — rendered as a DISABLED
 * entry with an honest face, so a builder can never create an app whose first
 * turn dies on a model the runtime refuses.
 *
 * Only `status === 'announced'` comes back: a `deprecated` row is not
 * announced and stays hidden here just as it is hidden from the pickers.
 * Empty for every provider since the 2026-09-08 Fable 5.1 flip — a real
 * state the consoles render as "nothing announced", not a vacuous one: the
 * registry tests keep the accessor honest over a synthetic announced row.
 */
export const announcedForProvider: RegistryAccessors["announcedForProvider"] = live.announcedForProvider;

/**
 * The model AXIS a framework's picker offers — its default provider's
 * invocable (ga|preview) rows, default first: `modelsForProvider` keyed by
 * framework. Every door that judges an `intendedModel` (the console's rack
 * and deploy snapshot, the backend's create validator) derives THIS list, so
 * no two of them can disagree about what "offered" means (guuey#647).
 */
export const modelsForFramework: RegistryAccessors["modelsForFramework"] = live.modelsForFramework;

/**
 * Is `id` on `framework`'s model axis? THE offered / off-registry predicate
 * (guuey#647), fail-closed: an `announced` row (known, not invocable), a
 * `deprecated` row, another provider's model and an id the registry has
 * never heard of all answer false. One rule for every door — a client that
 * copied it would be the second source of truth this exists to prevent.
 */
export const isOfferedModel: RegistryAccessors["isOfferedModel"] = live.isOfferedModel;

/**
 * Get the default model id for a framework's default provider.
 */
export const defaultModelFor: RegistryAccessors["defaultModelFor"] = live.defaultModelFor;

/**
 * Look up a model entry by id.
 */
export const modelEntry: RegistryAccessors["modelEntry"] = live.modelEntry;

/**
 * guuey#1606 — Claude ids the provider REFUSES `thinking: { type: "disabled" }`
 * on (Anthropic lists their thinking as "Adaptive (always on)"). Each entry is
 * a receipted 400 from a real call through the managed egress arm, never a
 * guess — `"thinking.type.disabled" is not supported for this model. Use
 * "thinking.type.adaptive" and "output_config.effort" to control thinking
 * behavior.`:
 *   - `claude-fable-5-1` — req_011CfKACj6c3sa8UJRH4Jx77 (QA, dev, 2026-09-22)
 *   - `claude-fable-5` — req_011CfKANbRX8VrXKVxLVLijA (QA, dev, 2026-09-22)
 *   - `claude-opus-5-5` — req_011CfK6KioUCDdzGcvmJHA1f (QA, dev, 2026-09-22)
 * Every other ga Claude id answered 200 on the same call and is NOT here:
 * `claude-sonnet-5` (the default), `claude-opus-5`, `claude-opus-4-8`,
 * `claude-sonnet-4-6`, `claude-haiku-4-5` (guuey#1606, 5784181150 / 5784211571).
 *
 * Not keyed on MODEL_REGISTRY on purpose: a guuey.json can name an id the
 * registry does not offer yet (`claude-opus-5-5` today), and the host must
 * still never send it the refused shape.
 *
 * Matched as a FAMILY, not an exact id (oss's review, 09-22): `agent.model`
 * is a free string (`agent.ts` `z.string().min(1)`), so a manifest can carry
 * `claude-fable-5-1[1m]`, a dated / `@`-suffixed form, or a bare Claude Code
 * alias the binary resolves itself. The failure is asymmetric — over-matching
 * only withdraws the forced handshake (the path these ids served on before
 * guuey#1183b), under-matching fails the whole turn — so the families are
 * matched with any `-` / `[` / `@` continuation, and the bare aliases `fable`
 * and `opus` count too (`opus` may resolve to 5.5 now that the SDK pin is past
 * 0.3.278, guuey#1607). `claude-opus-5` and every Sonnet / Haiku id stay out: they
 * answered 200.
 */
const REJECTS_DISABLED_THINKING_FAMILIES: readonly string[] = ["claude-fable-5", "claude-opus-5-5"];
const REJECTS_DISABLED_THINKING_ALIASES: ReadonlySet<string> = new Set(["fable", "opus"]);

/**
 * True when the provider refuses `thinking: { type: "disabled" }` for this
 * Claude model id (bare, or `anthropic/`-prefixed). The Claude host consults
 * it before disabling thinking for a bound first-impression turn (guuey#1183):
 * on these models the forced handshake is refused anyway, so the turn keeps
 * the model's default thinking instead of failing every request.
 */
export function rejectsDisabledThinking(modelId: string): boolean {
  const bare = (modelId.startsWith("anthropic/") ? modelId.slice("anthropic/".length) : modelId).toLowerCase();
  if (REJECTS_DISABLED_THINKING_ALIASES.has(bare)) return true;
  return REJECTS_DISABLED_THINKING_FAMILIES.some(
    (family) =>
      bare === family || bare.startsWith(`${family}-`) || bare.startsWith(`${family}[`) || bare.startsWith(`${family}@`),
  );
}
