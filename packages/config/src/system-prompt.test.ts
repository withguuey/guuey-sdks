/**
 * Pins on the two shipped prompt texts (guuey#463).
 *
 * `GUUEY_SCAFFOLD_SYSTEM_PROMPT` is load-bearing beyond the scaffold: `guuey
 * pull`'s known-default replace rule compares a builder's local
 * `prompts/system.md` against it byte-for-byte, so the export's SHAPE (a
 * trimmed, stable string distinct from the runtime default) is a contract,
 * not an implementation detail.
 *
 * The template-file equality check reads the checked-in template off disk and
 * skips when the monorepo is absent — same discipline as the CLI's wire-sync
 * guards: a consumer's installed `@guuey/config` has no `create-agentic-app`
 * source around it, and the monorepo is the only place drift can start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  GUUEY_DEFAULT_SYSTEM_PROMPT,
  GUUEY_SCAFFOLD_SYSTEM_PROMPT,
} from './system-prompt.js';

const TEMPLATE_PROMPT = fileURLToPath(
  new URL(
    '../../create-agentic-app/templates-src/core/prompts/system.md',
    import.meta.url,
  ),
);

describe('GUUEY_SCAFFOLD_SYSTEM_PROMPT', () => {
  it('is a non-empty trimmed string (the build stamp appends the one trailing newline)', () => {
    expect(GUUEY_SCAFFOLD_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(GUUEY_SCAFFOLD_SYSTEM_PROMPT).toBe(GUUEY_SCAFFOLD_SYSTEM_PROMPT.trim());
  });

  it('is distinct from the runtime default — two texts, two roles', () => {
    // SCAFFOLD is what `create-agentic-app` ships in prompts/system.md;
    // DEFAULT is the runtime fallback for an agent with no prompt at all.
    // Were they ever unified, pull's known-default set would silently halve.
    expect(GUUEY_SCAFFOLD_SYSTEM_PROMPT).not.toBe(GUUEY_DEFAULT_SYSTEM_PROMPT);
  });

  it.skipIf(!existsSync(TEMPLATE_PROMPT))(
    'byte-equals the checked-in template (as stamped: text + "\\n") — rerun build-templates.mjs after editing either side',
    () => {
      expect(readFileSync(TEMPLATE_PROMPT, 'utf8')).toBe(
        `${GUUEY_SCAFFOLD_SYSTEM_PROMPT}\n`,
      );
    },
  );
});
