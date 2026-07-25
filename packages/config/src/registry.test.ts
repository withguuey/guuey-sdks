import { describe, expect, it } from 'vitest';
import {
  MODEL_REGISTRY,
  FRAMEWORK_REGISTRY,
  modelsForProvider,
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
