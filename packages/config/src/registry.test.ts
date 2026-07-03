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
});

describe('modelsForProvider', () => {
  it('excludes announced entries', () => {
    const openaiModels = modelsForProvider('openai');
    expect(openaiModels.find((m) => m.id === 'gpt-5.6')).toBeUndefined();
  });

  it('lists the default first', () => {
    const openaiModels = modelsForProvider('openai');
    expect(openaiModels[0].isDefault).toBe(true);
    expect(openaiModels[0].id).toBe('gpt-5.5');
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

  it('gpt-5.6 is announced', () => {
    expect(modelEntry('gpt-5.6')?.status).toBe('announced');
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
