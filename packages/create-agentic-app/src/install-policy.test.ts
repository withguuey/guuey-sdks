/**
 * The scaffold's first run installs by itself (guuey#1000 — founder ruling,
 * verbatim: "i prefer auto install"). Before this the install was opt-in
 * (`--install`) and the printed "Next steps" led with `pnpm install`, which
 * a first-time builder skipped straight into `sh: tsup: not found` (#979).
 *
 * The decision is one pure function both scaffold paths (template + example)
 * and the "Next steps" print share, so the three cannot disagree.
 */
import { describe, expect, it } from 'vitest';
import { installByDefault } from './shared.js';

describe('installByDefault (guuey#1000)', () => {
  it('installs unless told not to — no flag, or unrelated flags, means install', () => {
    expect(installByDefault({})).toBe(true);
    expect(installByDefault({ framework: 'openai-agents-sdk', 'no-git': true })).toBe(true);
  });

  it('--no-install is the ONE opt-out', () => {
    expect(installByDefault({ 'no-install': true })).toBe(false);
  });

  it('the retired --install flag is not a switch — it neither enables nor disables (the default already installs)', () => {
    expect(installByDefault({ install: true })).toBe(true);
    expect(installByDefault({ install: true, 'no-install': true })).toBe(false);
  });
});
