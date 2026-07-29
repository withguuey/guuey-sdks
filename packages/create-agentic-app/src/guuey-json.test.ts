import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GuueyJsonV1 } from '@guuey/config';

const FRAMEWORKS = ['claude-agent-sdk', 'google-adk', 'openai-agents-sdk'];

describe('framework template guuey.json (guuey#24 §2c)', () => {
  for (const fw of FRAMEWORKS) {
    const raw = JSON.parse(
      readFileSync(join(__dirname, '..', 'templates-src', 'frameworks', fw, 'guuey.json'), 'utf8')
    );

    it(`${fw}: declares the ggui entry beside todo`, () => {
      expect(raw.agent.mcpServers.ggui).toEqual({
        kind: 'external',
        url: 'https://mcp.ggui.ai',
        transport: 'http',
      });
      expect(raw.agent.mcpServers.todo).toBeDefined();
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
