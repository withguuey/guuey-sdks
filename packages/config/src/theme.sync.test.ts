/**
 * Sync guard: the manifest theme schemas in `./theme.ts` are hand-mirrored
 * STRICT twins of `@guuey/chat`'s lenient theme vocabulary (dev-dependency
 * only — the runtime package must not carry the kit for a dozen key names).
 * This pins the vocabularies key-for-key, so a kit token addition without
 * a manifest-twin update fails HERE instead of silently rejecting newer
 * manifests in CI.
 *
 * The theming revision (guuey#1128 §3): the palette gains the derivation
 * ANCHORS (`secondaryAccent` / `onSecondaryAccent` / `success` / `warning` /
 * `info`), typography gains `headingFontFamily` + `faces`, shape gains
 * `shadow`, and `ramps` is GONE — ladders are derived by ggui's one producer,
 * never stated. A manifest that still states `ramps` is refused by the
 * strict twin (the manifest is the write side; pre-launch, no shim).
 */
import { describe, expect, it } from 'vitest';
import { GuueyChatFace, GuueyChatPalette, GuueyChatTheme } from '@guuey/chat';
import { AppThemeV1, ThemeFaceV1, ThemePaletteV1, ThemeShadowV1 } from './theme.js';

const keys = (shape: object): string[] => Object.keys(shape).sort();

describe('manifest theme mirrors the kit vocabulary key-for-key', () => {
  it('palette tokens', () => {
    expect(keys(ThemePaletteV1.shape)).toEqual(keys(GuueyChatPalette.shape));
  });

  it('typography members and the face record', () => {
    const kitTypography = GuueyChatTheme.shape.typography.shape;
    const twinTypography = AppThemeV1.shape.typography.unwrap().shape;
    expect(keys(twinTypography)).toEqual(keys(kitTypography));
    expect(keys(ThemeFaceV1.shape)).toEqual(keys(GuueyChatFace.shape));
  });

  it('shape members and the shadow record', () => {
    const kitShape = GuueyChatTheme.shape.shape.shape;
    const twinShape = AppThemeV1.shape.shape.unwrap().shape;
    expect(keys(twinShape)).toEqual(keys(kitShape));
    expect(keys(ThemeShadowV1.shape)).toEqual(keys(kitShape.shadow.unwrap().shape));
  });

  it('theme members — the manifest states a subset of the kit document, plus nothing', () => {
    const kit = new Set(Object.keys(GuueyChatTheme.shape));
    for (const member of Object.keys(AppThemeV1.shape)) {
      expect(kit.has(member), `manifest member '${member}' is not kit vocabulary`).toBe(true);
    }
    expect(kit.has('ramps')).toBe(false);
    expect('ramps' in AppThemeV1.shape).toBe(false);
  });

  it('a manifest-valid document is kit-valid verbatim (one vocabulary, strict ⊂ lenient)', () => {
    const manifest = {
      mode: 'light',
      colors: {
        light: {
          accent: '#c9a227', onAccent: '#0e1014', ink: '#1a1d24', inkMuted: '#6b7280',
          surface: '#ffffff', canvas: '#faf7ef', canvasMuted: '#f1ecdd', error: '#b3261e',
          secondaryAccent: '#7c3aed', onSecondaryAccent: '#ffffff', success: '#15803d',
        },
        dark: {
          accent: '#c9a227', onAccent: '#0e1014', ink: '#e7e8ec', inkMuted: '#9aa0ac',
          surface: '#1a1d24', canvas: '#0e1014', canvasMuted: '#1a1d24', error: '#ff5b5b',
        },
      },
      typography: {
        headingFontFamily: 'Fraunces, serif',
        faces: [{ family: 'Fraunces', src: 'https://fonts.gstatic.com/s/f.woff2', weight: '400 700' }],
      },
      shape: { radius: 'none', density: 'comfortable', shadow: { color: '#00000080', intensity: 0.4 } },
    };
    expect(AppThemeV1.safeParse(manifest).success).toBe(true);
    // The kit requires name the manifest may omit (server fills the kit
    // defaults) — parse the FILLED form the derivation produces.
    const filled = { name: 'x', ...manifest };
    expect(GuueyChatTheme.safeParse(filled).success).toBe(true);
  });

  it('strictness holds: unknown keys reject at the manifest tier — `ramps` included', () => {
    expect(AppThemeV1.safeParse({ mode: 'light', colors: {}, glow: true }).success).toBe(false);
    expect(
      AppThemeV1.safeParse({
        mode: 'light',
        colors: {},
        ramps: { light: { accent: { '500': '#c9a227', '600': '#a9861c', '700': '#8a6d15' } } },
      }).success,
    ).toBe(false);
  });
});
