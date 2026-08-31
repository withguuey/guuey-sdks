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

// ── guuey#545 — mode prompt { file } references resolve like the base prompt ──

describe('loadGuueyJson — mode prompt file references (guuey#545)', () => {
  const docWithModes = (modes: Record<string, unknown>) =>
    JSON.stringify({
      schema: '1',
      agent: { systemPrompt: 'Base brief.', modes },
    });

  it('a file-shaped systemPromptAppend resolves to the file contents and the snapshot is self-contained', () => {
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(join(dir, 'prompts', 'auth.md'), 'Signed-in extras.');
    writeFileSync(
      guueyJsonPath,
      docWithModes({ auth: { systemPromptAppend: { file: 'prompts/auth.md' } } }),
    );

    const loaded = loadGuueyJson(guueyJsonPath);
    expect(loaded.resolvedModePrompts).toEqual({
      auth: { systemPromptAppend: 'Signed-in extras.' },
    });
    // The document keeps the reference; the snapshot NEVER carries it —
    // the pod has no repo filesystem (the footgun this issue closes).
    expect(loaded.doc.agent.modes?.['auth']?.systemPromptAppend).toEqual({
      file: 'prompts/auth.md',
    });
    const snapshot = buildDeploySnapshot(loaded);
    expect(snapshot.agent.modes?.['auth']?.systemPromptAppend).toBe(
      'Signed-in extras.',
    );
  });

  it('a file-shaped mode systemPrompt resolves too, and inline strings pass through', () => {
    writeFileSync(join(dir, 'guest.md'), 'Guest replacement.');
    writeFileSync(
      guueyJsonPath,
      docWithModes({
        guest: { systemPrompt: { file: 'guest.md' } },
        auth: { systemPrompt: 'Inline auth brief.' },
      }),
    );
    const snapshot = buildDeploySnapshot(loadGuueyJson(guueyJsonPath));
    expect(snapshot.agent.modes?.['guest']?.systemPrompt).toBe(
      'Guest replacement.',
    );
    expect(snapshot.agent.modes?.['auth']?.systemPrompt).toBe(
      'Inline auth brief.',
    );
  });

  it('a missing mode prompt file FAILS the load loudly — never a silent unresolved ride-through', () => {
    writeFileSync(
      guueyJsonPath,
      docWithModes({ auth: { systemPromptAppend: { file: 'prompts/nope.md' } } }),
    );
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /agent\.modes\.auth\.systemPromptAppend\.file references missing file/,
    );
  });

  it('rejects absolute + parent-traversal mode prompt paths (same portability guards as the base prompt)', () => {
    writeFileSync(
      guueyJsonPath,
      docWithModes({ auth: { systemPrompt: { file: '/etc/passwd' } } }),
    );
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /agent\.modes\.auth\.systemPrompt\.file must be a relative path/,
    );

    writeFileSync(
      guueyJsonPath,
      docWithModes({ auth: { systemPrompt: { file: '../outside.md' } } }),
    );
    expect(() => loadGuueyJson(guueyJsonPath)).toThrow(
      /must not traverse parent directories/,
    );
  });

  it('mode tools/audience and non-prompt keys survive the inline verbatim', () => {
    writeFileSync(join(dir, 'auth.md'), 'From file.');
    writeFileSync(
      guueyJsonPath,
      docWithModes({
        auth: {
          systemPromptAppend: { file: 'auth.md' },
          tools: { allowlist: ['weather.*'] },
          audience: ['authenticated'],
        },
      }),
    );
    const snapshot = buildDeploySnapshot(loadGuueyJson(guueyJsonPath));
    const auth = snapshot.agent.modes?.['auth'];
    expect(auth?.tools).toEqual({ allowlist: ['weather.*'] });
    expect(auth?.audience).toEqual(['authenticated']);
  });

  it('no modes → resolvedModePrompts undefined', () => {
    writeFileSync(guueyJsonPath, JSON.stringify({ schema: '1', agent: {} }));
    expect(loadGuueyJson(guueyJsonPath).resolvedModePrompts).toBeUndefined();
  });
});
