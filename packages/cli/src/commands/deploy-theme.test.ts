import { describe, expect, it, vi } from 'vitest';
import type { ResolvedGuueyJson } from '@guuey/config';
import { maybeApplyThemeFromConfig, THEME_APPLIED_LINE, THEME_DOOR_LINE, THEME_KEPT_DOOR_LINE, THEME_KEPT_LINE, themeFromConfig } from './deploy-theme';

const CONFIG = { apiUrl: 'https://api.guuey.test/v1' };
const THEME = {
  name: 'acme',
  mode: 'light' as const,
  colors: {
    light: { accent: '#8b7cf6', onAccent: '#0e1014', ink: '#111318', inkMuted: '#5b6270', surface: '#ffffff', canvas: '#f7f7f5', canvasMuted: '#eceded', error: '#d64545' },
    dark: { accent: '#8b7cf6', onAccent: '#0e1014', ink: '#e8e9ee', inkMuted: '#9aa0ac', surface: '#1b1e26', canvas: '#0f1116', canvasMuted: '#1b1e26', error: '#ff6b6b' },
  },
  typography: {},
  shape: { radius: 'soft' as const, density: 'comfortable' as const },
};

function loadedWith(app: Record<string, unknown> | undefined, resolvedTheme?: typeof THEME): Pick<ResolvedGuueyJson, 'doc' | 'resolvedTheme'> {
  return {
    doc: { schema: '1', agent: {}, ...(app === undefined ? {} : { app }) } as unknown as ResolvedGuueyJson['doc'],
    resolvedTheme,
  };
}
/** An api whose GET answers `{ chatTheme: <stored> }` and whose PUT answers `status` / `body`. */
function apiWith(status: number, body: unknown = {}, stored: unknown = null) {
  return vi.fn(async (_pat: string, _cfg: { apiUrl?: string }, method: string) =>
    method === 'GET'
      ? new Response(JSON.stringify({ id: 'app-1', chatTheme: stored }), { status: 200 })
      : new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

describe('themeFromConfig', () => {
  it('is undefined without app.theme, the inline document when inline, the resolved file when a { file } ref', () => {
    expect(themeFromConfig(loadedWith(undefined))).toBeUndefined();
    expect(themeFromConfig(loadedWith({ name: 'x' }))).toBeUndefined();
    expect(themeFromConfig(loadedWith({ theme: THEME }))).toEqual(THEME);
    expect(themeFromConfig(loadedWith({ theme: { file: 'theme.json' } }, THEME))).toEqual(THEME);
  });
});

describe('maybeApplyThemeFromConfig (guuey#1130 G59)', () => {
  it('POSITIVE CONTROL — writes app.theme through the same door as --chat-theme-file and says so', async () => {
    const api = apiWith(200, { id: 'app-1' });
    const logs: string[] = [];
    const warns: string[] = [];
    const outcome = await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api, log: (l) => logs.push(l), warn: (l) => warns.push(l) });
    expect(outcome).toBe('applied');
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenNthCalledWith(1, 'pat', CONFIG, 'GET', '/apps/app-1');
    expect(api).toHaveBeenNthCalledWith(2, 'pat', CONFIG, 'PUT', '/apps/app-1', { chatTheme: THEME });
    expect(logs).toEqual([THEME_APPLIED_LINE]);
    expect(warns).toEqual([]);
  });

  it('a { file } reference writes the RESOLVED document', async () => {
    const api = apiWith(200);
    await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: { file: 'theme.json' } }, THEME), { api, log: () => {}, warn: () => {} });
    expect(api).toHaveBeenCalledWith('pat', CONFIG, 'PUT', '/apps/app-1', { chatTheme: THEME });
  });

  it('no app.theme → nothing sent, nothing printed', async () => {
    const api = apiWith(200);
    const logs: string[] = [];
    expect(await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith(undefined), { api, log: (l) => logs.push(l), warn: (l) => logs.push(l) })).toBe('none');
    expect(api).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it('an app that already HAS a chat theme is never overwritten: no PUT, the kept line names the explicit doors', async () => {
    const api = apiWith(200, {}, { name: 'console-set' });
    const warns: string[] = [];
    const outcome = await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api, log: () => {}, warn: (l) => warns.push(l) });
    expect(outcome).toBe('kept');
    expect(api).toHaveBeenCalledTimes(1); // the GET only
    expect(api.mock.calls.some((c) => c[2] === 'PUT')).toBe(false);
    expect(warns).toEqual([THEME_KEPT_LINE, THEME_KEPT_DOOR_LINE]);
    expect(warns.join('\n')).toContain('--chat-theme-file');
  });

  it('when the current theme cannot be read, nothing is written (a blind write could be the overwrite)', async () => {
    const api = vi.fn(async (_p: string, _c: { apiUrl?: string }, method: string) =>
      method === 'GET' ? new Response('nope', { status: 503 }) : new Response('{}', { status: 200 }),
    );
    const warns: string[] = [];
    expect(await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api, log: () => {}, warn: (l) => warns.push(l) })).toBe('failed');
    expect(api.mock.calls.some((c) => c[2] === 'PUT')).toBe(false);
    expect(warns[0]).toContain('could not read');
  });

  it("a validator refusal is a loud line carrying the server's path-naming message and the door — never a throw", async () => {
    const api = apiWith(400, { error: { code: 'CHAT_THEME_INVALID', message: 'chatTheme.colors.light.accent must be a hex colour like #2f6bff' } });
    const warns: string[] = [];
    const outcome = await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api, log: () => {}, warn: (l) => warns.push(l) });
    expect(outcome).toBe('refused');
    expect(warns[0]).toContain('app.theme was NOT applied');
    expect(warns[0]).toContain('chatTheme.colors.light.accent');
    expect(warns[1]).toBe(THEME_DOOR_LINE);
  });

  it('a transport failure or a 5xx is reported the same way and never fails the deploy', async () => {
    const warns: string[] = [];
    const thrown = vi.fn(async (_p: string, _c: { apiUrl?: string }, method: string) => {
      if (method === 'GET') return new Response(JSON.stringify({ id: 'app-1', chatTheme: null }), { status: 200 });
      throw new Error('ECONNRESET');
    });
    expect(await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api: thrown, log: () => {}, warn: (l) => warns.push(l) })).toBe('failed');
    expect(warns[0]).toContain('ECONNRESET');
    expect(await maybeApplyThemeFromConfig('pat', CONFIG, 'app-1', loadedWith({ theme: THEME }), { api: apiWith(503, 'not json'), log: () => {}, warn: () => {} })).toBe('failed');
  });
});
