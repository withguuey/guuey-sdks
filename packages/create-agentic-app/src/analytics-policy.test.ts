/**
 * guuey#1062 — opt-in analytics, both directions (platform's ruling on the row):
 * the default scaffold carries ZERO analytics bytes; `--analytics posthog`
 * emits a loader keyed from the app's env, never a key literal.
 */
import { describe, expect, it } from 'vitest';
import { injectAnalytics, parseAnalyticsFlag, POSTHOG_LOADER_HTML } from './analytics.js';

const SHELL = '<!doctype html>\n<html><head><title>x</title></head><body><div id="root"></div></body></html>\n';

describe('parseAnalyticsFlag (guuey#1062)', () => {
  it('absent flag = none (the default)', () => {
    expect(parseAnalyticsFlag({})).toEqual({ kind: 'none' });
    expect(parseAnalyticsFlag({ framework: 'google-adk', 'no-install': true })).toEqual({ kind: 'none' });
  });
  it('--analytics posthog opts in', () => {
    expect(parseAnalyticsFlag({ analytics: 'posthog' })).toEqual({ kind: 'provider', provider: 'posthog' });
  });
  it('a bare or unknown provider is refused with the supported list named', () => {
    const bare = parseAnalyticsFlag({ analytics: true });
    expect(bare.kind).toBe('invalid');
    if (bare.kind === 'invalid') expect(bare.message).toContain('--analytics posthog');
    const unknown = parseAnalyticsFlag({ analytics: 'ga' });
    expect(unknown.kind).toBe('invalid');
    if (unknown.kind === 'invalid') expect(unknown.given).toBe('ga');
  });
});

describe('injectAnalytics (guuey#1062)', () => {
  it('default: the html is byte-identical and carries no analytics bytes', () => {
    const out = injectAnalytics(SHELL, undefined);
    expect(out).toBe(SHELL);
    expect(/posthog/i.test(out)).toBe(false);
  });
  it('--analytics posthog: the loader sits in <head>, keyed from VITE_POSTHOG_KEY, with no key literal', () => {
    const out = injectAnalytics(SHELL, 'posthog');
    expect(out.indexOf(POSTHOG_LOADER_HTML)).toBeGreaterThan(-1);
    expect(out.indexOf(POSTHOG_LOADER_HTML)).toBeLessThan(out.indexOf('</head>'));
    expect(out).toContain('%VITE_POSTHOG_KEY%');
    expect(out).toContain('%VITE_POSTHOG_HOST%');
    expect(out).toContain("cookieless_mode: 'always'");
    expect(out).toContain("register({ surface: 'demo' })");
    expect(/phc_[A-Za-z0-9]{10,}/.test(out)).toBe(false);
  });
  it('the loader renders nothing when Vite leaves the token unreplaced (no key configured)', () => {
    // The guard the emitted script runs before touching PostHog.
    expect(POSTHOG_LOADER_HTML).toContain('key.charAt(0) === "%"');
  });
  it('a shell without </head> is refused loudly rather than silently unmodified', () => {
    expect(() => injectAnalytics('<html><body></body></html>', 'posthog')).toThrow(/<\/head>/);
  });
});
