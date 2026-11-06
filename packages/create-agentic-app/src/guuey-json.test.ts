import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuueyJsonV1, effectiveMcpServers, newRepDefaultHooks } from '@guuey/config';

const FRAMEWORKS = ['claude-agent-sdk', 'google-adk', 'openai-agents-sdk'];

describe('framework template guuey.json (guuey#24 §2c)', () => {
  for (const fw of FRAMEWORKS) {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '..', 'templates-src', 'frameworks', fw, 'guuey.json'), 'utf8')
    );

    it(`${fw}: is born with generative UI off — \`ggui: false\`, opt-in by deleting it`, () => {
      // Generative UI is opt-in for a NEW agent: the scaffold declares the
      // opt-out, so neither the deployed agent (effectiveMcpServers) nor
      // `guuey dev` (lowerForDev skips its local injection when a ggui key
      // is present) attaches it. Deleting the line turns it on in both.
      expect(raw.agent.mcpServers.ggui).toBe(false);
      expect(raw.agent.mcpServers.todo).toBeDefined();
      const parsed = GuueyJsonV1.parse(JSON.parse(JSON.stringify(raw).replace('MODEL_PLACEHOLDER', 'claude-sonnet-5')));
      expect(effectiveMcpServers(parsed.agent.mcpServers)).not.toHaveProperty('ggui');
    });

    it(`${fw}: round-trips the config schema`, () => {
      // MODEL_PLACEHOLDER is substituted for the real model at build-templates
      // time (stampModel -> defaultModelFor); any valid model string is fine
      // here since this test only exercises the schema round-trip.
      const parsed = JSON.parse(JSON.stringify(raw).replace('MODEL_PLACEHOLDER', 'claude-sonnet-5'));
      expect(() => GuueyJsonV1.parse(parsed)).not.toThrow();
    });
  }
});

describe('the declarative agent template (guuey#1738)', () => {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'templates-src', 'agent', 'guuey.json'), 'utf8'));

  it('starts a new rep with the platform default hooks, verbatim (a JSON twin of newRepDefaultHooks)', () => {
    expect(raw.agent.hooks).toEqual(newRepDefaultHooks());
  });

  it('is born with generative UI off — `ggui: false`, opt-in by deleting it', () => {
    expect(raw.agent.mcpServers).toEqual({ ggui: false });
    const parsed = GuueyJsonV1.parse(JSON.parse(JSON.stringify(raw).replace('MODEL_PLACEHOLDER', 'claude-sonnet-5')));
    expect(effectiveMcpServers(parsed.agent.mcpServers)).not.toHaveProperty('ggui');
  });

  it('round-trips the config schema with the hooks block', () => {
    const parsed = JSON.parse(JSON.stringify(raw).replace('MODEL_PLACEHOLDER', 'claude-sonnet-5'));
    expect(GuueyJsonV1.parse(parsed).agent.hooks).toEqual(newRepDefaultHooks());
  });
});
