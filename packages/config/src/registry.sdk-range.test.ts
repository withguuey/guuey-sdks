/**
 * `CLAUDE_AGENT_SDK_SUPPORTED`: the claude-agent-sdk versions guuey runs a code-mode package on, and the predicate every
 * consumer (the deploy-controller's package pusher, the CLI) shares. The floor is re-read from `@guuey/host`'s own
 * manifest, by path inside oss/, the same pattern as registry.pins.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_AGENT_SDK_SUPPORTED,
  FRAMEWORK_REGISTRY,
  claudeAgentSdkUnsupportedLine,
  isClaudeAgentSdkSupported,
} from './registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOST_PKG = join(here, '..', '..', 'host', 'package.json');

describe('CLAUDE_AGENT_SDK_SUPPORTED', () => {
  it('admits its floor and refuses its ceiling (inclusive / exclusive)', () => {
    expect(isClaudeAgentSdkSupported(CLAUDE_AGENT_SDK_SUPPORTED.min)).toBe(true);
    expect(isClaudeAgentSdkSupported(CLAUDE_AGENT_SDK_SUPPORTED.belowExclusive)).toBe(false);
  });

  it('compares numerically part by part, never as text', () => {
    expect(isClaudeAgentSdkSupported('0.3.198')).toBe(false);
    expect(isClaudeAgentSdkSupported('0.3.1000')).toBe(true);
    expect(isClaudeAgentSdkSupported('0.30.0')).toBe(false);
    expect(isClaudeAgentSdkSupported('0.10.0')).toBe(false);
    expect(isClaudeAgentSdkSupported('0.2.999')).toBe(false);
    expect(isClaudeAgentSdkSupported('1.0.0')).toBe(false);
  });

  it('is fail-closed on anything that is not an exact x.y.z', () => {
    for (const v of ['', '^0.3.282', '~0.3.282', 'v0.3.282', '0.3.282-rc.1', '0.3', '0.3.282.1', '00.3.282', ' 0.3.282']) {
      expect(isClaudeAgentSdkSupported(v), JSON.stringify(v)).toBe(false);
    }
  });

  it('holds the image pin (FRAMEWORK_REGISTRY.platformPinnedVersion)', () => {
    const claude = FRAMEWORK_REGISTRY.find((row) => row.framework === 'claude-agent-sdk');
    expect(claude?.platformPinnedVersion).toBeTypeOf('string');
    expect(isClaudeAgentSdkSupported(claude?.platformPinnedVersion ?? '')).toBe(true);
  });

  it("starts at @guuey/host's peer floor, so a host-compatible worker is never refused below it", () => {
    const host = JSON.parse(readFileSync(HOST_PKG, 'utf8')) as { peerDependencies?: Record<string, string> };
    const peer = host.peerDependencies?.['@anthropic-ai/claude-agent-sdk'];
    expect(peer).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(CLAUDE_AGENT_SDK_SUPPORTED.min).toBe(peer?.slice(1));
  });

  it('a malformed range refuses everything (fail-closed)', () => {
    expect(isClaudeAgentSdkSupported('0.3.282', { min: '0.3', belowExclusive: '0.4.0' })).toBe(false);
    expect(isClaudeAgentSdkSupported('0.3.282', { min: '0.3.199', belowExclusive: 'next' })).toBe(false);
  });

  it("words the builder's line with the version and both bounds", () => {
    expect(claudeAgentSdkUnsupportedLine('0.2.50')).toBe(
      'Your app uses @anthropic-ai/claude-agent-sdk 0.2.50; guuey runs 0.3.199 up to (not including) 0.4.0. ' +
        'Change the version in package.json, reinstall, and deploy again.',
    );
    expect(claudeAgentSdkUnsupportedLine('x'.repeat(100))).toContain(`${'x'.repeat(40)};`);
  });
});
