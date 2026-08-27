import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDeploySnapshot, loadGuueyJson } from './loader.js';

const PALETTE = {
  accent: '#c9a227',
  onAccent: '#0e1014',
  ink: '#1a1d24',
  inkMuted: '#6b7280',
  surface: '#ffffff',
  canvas: '#faf7ef',
  canvasMuted: '#f1ecdd',
  error: '#b3261e',
};

const THEME = {
  mode: 'light',
  colors: { light: PALETTE, dark: { ...PALETTE, surface: '#1a1d24' } },
};

function docWithTheme(theme: unknown): string {
  return JSON.stringify({
    schema: '1',
    agent: { model: 'claude-sonnet-5', systemPrompt: 'inline prompt' },
    app: { theme },
  });
}

let dir: string;
let guueyJsonPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-loader-test-'));
  guueyJsonPath = join(dir, 'guuey.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadGuueyJson — app.theme file reference (guuey#400)', () => {
  it('resolves { file } relative to guuey.json and buildDeploySnapshot inlines it', () => {
    mkdirSync(join(dir, 'design'));
    writeFileSync(join(dir, 'design', 'theme.json'), JSON.stringify(THEME));
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'design/theme.json' }));

    const loaded = loadGuueyJson(guueyJsonPath);
    expect(loaded.resolvedTheme).toEqual(THEME);
    // The document keeps the reference intact…
    expect(loaded.doc.app?.theme).toEqual({ file: 'design/theme.json' });
    // …and the snapshot is self-contained.
    const snapshot = buildDeploySnapshot(loaded);
    expect(snapshot.app?.theme).toEqual(THEME);
  });

  it('an inline theme passes through untouched (resolvedTheme is the document block)', () => {
    writeFileSync(guueyJsonPath, docWithTheme(THEME));
    const loaded = loadGuueyJson(guueyJsonPath);
    expect(loaded.resolvedTheme).toEqual(THEME);
    expect(buildDeploySnapshot(loaded).app?.theme).toEqual(THEME);
  });

  it('no app.theme → resolvedTheme undefined', () => {
    writeFileSync(guueyJsonPath, JSON.stringify({ schema: '1', agent: {} }));
    expect(loadGuueyJson(guueyJsonPath).resolvedTheme).toBeUndefined();
  });

  it('rejects an absolute theme path (snapshot must stay portable)', () => {
    writeFileSync(guueyJsonPath, docWithTheme({ file: `${sep}etc${sep}theme.json` }));
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /app\.theme\.file must be a relative path/,
    );
  });

  it('rejects parent-directory traversal', () => {
    writeFileSync(guueyJsonPath, docWithTheme({ file: '../theme.json' }));
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /app\.theme\.file must not traverse parent directories/,
    );
  });

  it('a missing theme file names the reference and the resolved path', () => {
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'theme.json' }));
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /app\.theme\.file references missing file: theme\.json/,
    );
  });

  it('a theme file that is not JSON fails with the parse error', () => {
    writeFileSync(join(dir, 'theme.json'), 'not json');
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'theme.json' }));
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /app\.theme\.file theme\.json is not valid JSON/,
    );
  });

  it('theme file CONTENT is validated STRICT — an unknown key rejects loudly', () => {
    writeFileSync(join(dir, 'theme.json'), JSON.stringify({ ...THEME, glow: true }));
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'theme.json' }));
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /app\.theme\.file theme\.json failed theme validation/,
    );
  });

  it('shape only — a colour VALUE the server grammar would reject passes the loader', () => {
    // Value errors belong to the server's one validator (`validateChatTheme`)
    // so plan/apply surfaces ITS exact message, never a divergent local one.
    const sloppy = {
      ...THEME,
      colors: { ...THEME.colors, light: { ...PALETTE, accent: 'olive' } },
    };
    writeFileSync(join(dir, 'theme.json'), JSON.stringify(sloppy));
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'theme.json' }));
    expect(loadGuueyJson(guueyJsonPath).resolvedTheme).toEqual(sloppy);
  });

  it('mutating the built snapshot leaks nothing back into the loaded result', () => {
    writeFileSync(join(dir, 'theme.json'), JSON.stringify(THEME));
    writeFileSync(guueyJsonPath, docWithTheme({ file: 'theme.json' }));
    const loaded = loadGuueyJson(guueyJsonPath);
    const snapshot = buildDeploySnapshot(loaded);
    if (snapshot.app?.theme !== undefined && 'mode' in snapshot.app.theme) {
      snapshot.app.theme.mode = 'dark';
    }
    expect(loaded.resolvedTheme?.mode).toBe('light');
  });
});
