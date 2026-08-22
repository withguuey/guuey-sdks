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

    it(`${fw}: does NOT declare a ggui entry — injection owns it (guuey#368)`, () => {
      // The old #24 §2c pin (declare the platform default verbatim) is
      // INVERTED by #368: a declared platform-default entry suppressed
      // lowerForDev's local injection and was un-dialable locally, so the
      // out-of-box scaffold silently lost generative UI. The platform
      // injects mcp.ggui.ai on deploy; guuey dev injects the local
      // endpoint — the template stays silent and both environments work.
      expect(raw.agent.mcpServers.ggui).toBeUndefined();
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
