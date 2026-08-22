/**
 * Sync guard: the manifest theme schemas in `./theme.ts` are hand-mirrored
 * STRICT twins of `@guuey/chat`'s lenient theme vocabulary (dev-dependency
 * only — the runtime package must not carry the kit for eight key names).
 * This pins the vocabularies key-for-key, so a kit token/slot addition
 * without a manifest-twin update fails HERE instead of silently rejecting
 * newer manifests in CI.
 */
import { describe, expect, it } from 'vitest';
import {
  GuueyChatAccentRamp,
  GuueyChatErrorRamp,
  GuueyChatPalette,
  GuueyChatRamps,
  GuueyChatRampSet,
  GuueyChatTheme,
  GuueyChatToneRamp,
} from '@guuey/chat';
import {
  AppThemeV1,
  ThemeAccentRampV1,
  ThemeErrorRampV1,
  ThemePaletteV1,
  ThemeRampSetV1,
  ThemeRampsV1,
  ThemeToneRampV1,
} from './theme.js';

const keys = (shape: object): string[] => Object.keys(shape).sort();

describe('manifest theme mirrors the kit vocabulary key-for-key', () => {
  it('palette tokens', () => {
    expect(keys(ThemePaletteV1.shape)).toEqual(keys(GuueyChatPalette.shape));
  });

  it('ramp families and slots', () => {
    expect(keys(ThemeRampSetV1.shape)).toEqual(keys(GuueyChatRampSet.shape));
    expect(keys(ThemeRampsV1.shape)).toEqual(keys(GuueyChatRamps.shape));
    expect(keys(ThemeAccentRampV1.shape)).toEqual(keys(GuueyChatAccentRamp.shape));
    expect(keys(ThemeErrorRampV1.shape)).toEqual(keys(GuueyChatErrorRamp.shape));
    expect(keys(ThemeToneRampV1.shape)).toEqual(keys(GuueyChatToneRamp.shape));
  });

  it('theme members — the manifest states a subset of the kit document, plus nothing', () => {
    const kit = new Set(Object.keys(GuueyChatTheme.shape));
    for (const member of Object.keys(AppThemeV1.shape)) {
      expect(kit.has(member), `manifest member '${member}' is not kit vocabulary`).toBe(true);
    }
  });

  it('a manifest-valid document is kit-valid verbatim (one vocabulary, strict ⊂ lenient)', () => {
    const manifest = {
      mode: 'light',
      colors: {
        light: {
          accent: '#c9a227', onAccent: '#0e1014', ink: '#1a1d24', inkMuted: '#6b7280',
          surface: '#ffffff', canvas: '#faf7ef', canvasMuted: '#f1ecdd', error: '#b3261e',
        },
        dark: {
          accent: '#c9a227', onAccent: '#0e1014', ink: '#e7e8ec', inkMuted: '#9aa0ac',
          surface: '#1a1d24', canvas: '#0e1014', canvasMuted: '#1a1d24', error: '#ff5b5b',
        },
      },
      ramps: { light: { accent: { '500': '#c9a227', '600': '#a9861c', '700': '#8a6d15' } } },
    };
    expect(AppThemeV1.safeParse(manifest).success).toBe(true);
    // The kit requires name/shape the manifest may omit (server fills the
    // kit defaults) — parse the FILLED form the derivation produces.
    const filled = { name: 'x', typography: {}, shape: { radius: 'soft', density: 'comfortable' }, ...manifest };
    expect(GuueyChatTheme.safeParse(filled).success).toBe(true);
  });

  it('strictness holds: unknown keys reject at the manifest tier', () => {
    expect(
      AppThemeV1.safeParse({ mode: 'light', colors: {}, glow: true }).success,
    ).toBe(false);
  });
});
