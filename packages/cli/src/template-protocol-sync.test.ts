/**
 * Sync guard (guuey#943): the scaffold template's `ggui.json#protocol` MUST be
 * the protocol version the paired `@ggui-ai/protocol` exports. ggui 0.15.0's
 * loader accepts only its own draft (versionPolicy reject), so a stale pin
 * means a builder's FIRST `ggui dev` after `create-agentic-app` fails with
 * UPGRADE_REQUIRED — the worst first minute a template can give.
 *
 * Lives here, not in create-agentic-app: that package deliberately has no
 * `@ggui-ai/*` dependency (it ships JSON + prompts), while the CLI pins the
 * family — the same read-the-other-package-as-text idiom as `wire-sync.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';

const TEMPLATE = join(__dirname, '..', '..', 'create-agentic-app', 'templates-src', 'core', 'ggui', 'ggui.json');

describe('create-agentic-app template — ggui.json#protocol tracks @ggui-ai/protocol (guuey#943)', () => {
  it('pins exactly the exported PROTOCOL_VERSION', () => {
    const doc = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as { protocol?: unknown };
    expect(typeof doc.protocol).toBe('string');
    expect(doc.protocol).toBe(PROTOCOL_VERSION);
  });
  it('the exported version is a dated draft, not an empty string (a regression here would make the pin vacuous)', () => {
    expect(PROTOCOL_VERSION).toMatch(/^draft-\d{4}-\d{2}-\d{2}$/);
  });
});
