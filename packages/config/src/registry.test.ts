import { describe, expect, it } from 'vitest';
import {
  MODEL_REGISTRY,
  FRAMEWORK_REGISTRY,
  modelsForProvider,
  lineupForProvider,
  legacyForProvider,
  defaultModelFor,
  modelEntry,
} from './registry.js';

describe('MODEL_REGISTRY invariants', () => {
  it('has exactly one isDefault per provider and it is ga', () => {
    const providers = ['anthropic', 'openai', 'google'] as const;
    for (const provider of providers) {
      const defaults = MODEL_REGISTRY.filter((m) => m.provider === provider && m.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0].status).toBe('ga');
    }
  });

  it('every id is unique', () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });

  it('defaultModelFor("claude-agent-sdk") === "claude-sonnet-5"', () => {
    expect(defaultModelFor('claude-agent-sdk')).toBe('claude-sonnet-5');
  });

  // Per-provider defaults are money-visible (they pick the rate a new agent
  // meters at) and product-visible (the picker's first item), so each one is
  // pinned by id, not just by "some default exists".
  it('defaultModelFor("openai-agents-sdk") === "gpt-5.6-terra"', () => {
    // Deliberate divergence from OpenAI's own `gpt-5.6` alias (which routes to
    // Sol) — founder cost/balance call 2026-07-25; see MODEL_REGISTRY comment.
    expect(defaultModelFor('openai-agents-sdk')).toBe('gpt-5.6-terra');
  });

  it('defaultModelFor("google-adk") === "gemini-3.6-flash"', () => {
    expect(defaultModelFor('google-adk')).toBe('gemini-3.6-flash');
  });
});

describe('modelsForProvider — the status filter, exercised (guuey#635: claude-fable-5-1 is announced)', () => {
  it('an announced row is IN MODEL_REGISTRY but EXCLUDED from the picker until the runtime can invoke it', () => {
    const row = MODEL_REGISTRY.find((m) => m.id === 'claude-fable-5-1');
    expect(row?.status).toBe('announced');
    expect(modelsForProvider('anthropic').map((m) => m.id)).not.toContain('claude-fable-5-1');
  });
});

describe('modelsForProvider', () => {
  it('exposes exactly this literal id set per provider (a drop, rename or provider re-tag goes red)', () => {
    // LITERAL expectations on purpose. Re-deriving the expected side from
    // `MODEL_REGISTRY` with modelsForProvider's OWN predicate makes both sides
    // move together, so it can only ever prove provider membership — never the
    // status filter. Written out, the sets are pinned against silent drops,
    // renames and provider re-tags. Update these arrays deliberately when a wave
    // adds or retires a model.
    //
    // Honest scope of the status half: the July 2026 wave retired the last
    // `announced` entry, so there is nothing for `modelsForProvider` to exclude
    // and its exclusion branch is currently UNTESTED — no test in this file can
    // catch a widening today. What the literal side buys is that the day a
    // future wave re-introduces an `announced` stub, a filter widened to admit
    // it turns this red; the re-derived version never would.
    const expected: Record<'anthropic' | 'openai' | 'google' | 'openrouter', string[]> = {
      anthropic: [
        'claude-sonnet-5',
        'claude-fable-5',
        'claude-opus-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
        'claude-opus-4-8',
      ],
      openai: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-4o', 'gpt-4o-mini'],
      google: [
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.1-pro',
        'gemini-2.5-flash',
        'gemini-2.5-pro',
      ],
      // No openrouter model is offered today — pinned so one can't appear unnoticed.
      openrouter: [],
    };
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      expect(
        modelsForProvider(provider).map((m) => m.id).sort(),
        `modelsForProvider("${provider}") drifted from the pinned id set`,
      ).toEqual([...expected[provider]].sort());
    }
  });

  it('lists the default first', () => {
    const openaiModels = modelsForProvider('openai');
    expect(openaiModels[0].isDefault).toBe(true);
    expect(openaiModels[0].id).toBe('gpt-5.6-terra');
  });

  it('only includes ga and preview status', () => {
    const openaiModels = modelsForProvider('openai');
    for (const model of openaiModels) {
      expect(['ga', 'preview']).toContain(model.status);
    }
  });
});

/**
 * `lineup` is the picker's front slice (guuey#637). These invariants are what
 * let a picker render `lineupForProvider` up front and put
 * `legacyForProvider` behind a "See all models" door WITHOUT risking that a
 * model becomes unreachable — the failure mode a positional `.slice()` has and
 * a partition does not.
 */
describe('lineupForProvider / legacyForProvider', () => {
  const providers = ['anthropic', 'openai', 'google'] as const;

  it('partitions modelsForProvider: disjoint, exhaustive, order-preserving', () => {
    for (const p of providers) {
      const all = modelsForProvider(p).map((m) => m.id);
      const lineup = lineupForProvider(p).map((m) => m.id);
      const legacy = legacyForProvider(p).map((m) => m.id);
      expect(lineup.filter((id) => legacy.includes(id))).toEqual([]);
      expect(new Set([...lineup, ...legacy])).toEqual(new Set(all));
      expect(lineup.length + legacy.length).toBe(all.length);
      // Each half keeps modelsForProvider's relative order.
      expect(lineup).toEqual(all.filter((id) => lineup.includes(id)));
      expect(legacy).toEqual(all.filter((id) => legacy.includes(id)));
    }
  });

  it('every provider has a non-empty lineup whose first entry is its default', () => {
    for (const p of providers) {
      const lineup = lineupForProvider(p);
      expect(lineup.length).toBeGreaterThan(0);
      expect(lineup[0].isDefault).toBe(true);
    }
  });

  it('a lineup entry is always invocable (ga|preview) — the door is curation, not lifecycle', () => {
    for (const entry of MODEL_REGISTRY.filter((m) => m.lineup === true)) {
      expect(['ga', 'preview']).toContain(entry.status);
    }
  });

  it("anthropic's lineup is the 2026-09-02 generation minus the not-yet-invocable; Fable 5 sits behind the door", () => {
    // Fable 5.1 is `announced` until #659's image rolls (the pod binary 400s
    // it), so it is in NEITHER half today. Its ga flip is TWO fields on the
    // row — `status: 'ga'` + `lineup: true` — and this set grows by it then.
    expect(new Set(lineupForProvider('anthropic').map((m) => m.id))).toEqual(
      new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5']),
    );
    expect(modelEntry('claude-fable-5-1')?.status).toBe('announced');
    expect(lineupForProvider('anthropic').map((m) => m.id)).not.toContain('claude-fable-5-1');
    expect(legacyForProvider('anthropic').map((m) => m.id)).not.toContain('claude-fable-5-1');
    // Behind the door, NOT deprecated: the deprecations page lists
    // claude-fable-5 as Active with no deprecation date.
    expect(legacyForProvider('anthropic').map((m) => m.id)).toContain('claude-fable-5');
    expect(modelEntry('claude-fable-5')?.status).toBe('ga');
  });
});

describe('modelEntry', () => {
  it('returns undefined for unknown id', () => {
    expect(modelEntry('unknown-model')).toBeUndefined();
  });

  it('the bare `gpt-5.6` alias is NOT a registry id — only sol/terra/luna are offered', () => {
    // OpenAI's `gpt-5.6` alias routes to Sol. guuey never offers the alias in a
    // picker (it would be an ambiguous, silently-repointable id); the rate card
    // still rows it at Sol's price so a BYO-config call using it can't
    // under-meter against the bare `gpt-5` row.
    expect(modelEntry('gpt-5.6')).toBeUndefined();
    expect(modelEntry('gpt-5.6-sol')?.status).toBe('ga');
    expect(modelEntry('gpt-5.6-terra')?.isDefault).toBe(true);
    expect(modelEntry('gpt-5.6-luna')?.status).toBe('ga');
  });

  it('returns the correct model entry', () => {
    const entry = modelEntry('claude-sonnet-5');
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe('anthropic');
    expect(entry?.label).toBe('Claude Sonnet 5');
    expect(entry?.isDefault).toBe(true);
  });
});

describe('FRAMEWORK_REGISTRY invariants', () => {
  it('all framework entries have valid framework values', () => {
    const validFrameworks = ['claude-agent-sdk', 'openai-agents-sdk', 'google-adk', 'vanilla'];
    for (const entry of FRAMEWORK_REGISTRY) {
      expect(validFrameworks).toContain(entry.framework);
    }
  });

  it('each framework has a defaultProvider matching the model registry', () => {
    for (const fw of FRAMEWORK_REGISTRY) {
      const hasDefault = MODEL_REGISTRY.some((m) => m.provider === fw.defaultProvider && m.isDefault);
      expect(hasDefault).toBe(true);
    }
  });
});
