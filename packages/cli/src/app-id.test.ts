/**
 * `resolveTargetAppId` — the `--app-id`-overrides-config contract (guuey#183).
 *
 * The flag is documented as a global option ("Target a specific app —
 * overrides config"); this pins the precedence every app-scoped command
 * routes through.
 */
import { describe, expect, it } from 'vitest';
import { resolveTargetAppId } from './app-id.js';

describe('resolveTargetAppId', () => {
  it('an explicit --app-id wins over the bound config.appId', () => {
    expect(
      resolveTargetAppId({ 'app-id': 'app-override' }, { appId: 'app-bound' }),
    ).toBe('app-override');
  });

  it('falls back to config.appId when no flag is passed', () => {
    expect(resolveTargetAppId({}, { appId: 'app-bound' })).toBe('app-bound');
    expect(resolveTargetAppId(undefined, { appId: 'app-bound' })).toBe('app-bound');
  });

  it('a valueless --app-id (parsed as `true`) is not an override', () => {
    expect(resolveTargetAppId({ 'app-id': true }, { appId: 'app-bound' })).toBe('app-bound');
  });

  it('returns undefined when neither flag nor binding names an app', () => {
    expect(resolveTargetAppId({}, {})).toBeUndefined();
  });
});
