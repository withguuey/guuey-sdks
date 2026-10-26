import { describe, expect, it, vi } from 'vitest';
import { appChatThemeState, maybePrintThemeHint, THEME_HINT_LINES } from './theme-hint';

/** An api whose `GET /apps/:id` answers `body` as JSON with `status`. */
function apiReturning(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const CONFIG = { apiUrl: 'https://api.guuey.test/v1' };

describe('appChatThemeState (guuey#2401)', () => {
  it('reads chatTheme off the app projection the server answers: { app: { chatTheme } }', () => {
    expect(appChatThemeState({ app: { id: 'app-1', chatTheme: null } })).toBe('none');
    expect(appChatThemeState({ app: { id: 'app-1', chatTheme: { name: 'brand-v2' } }, firstImpression: {} })).toBe('set');
  });

  it("is 'unknown' for every body that is not that projection — a top-level chatTheme included", () => {
    for (const body of [
      { id: 'app-1', chatTheme: null },
      { app: { id: 'app-1' } },
      { app: null },
      { app: 'app-1' },
      { applied: true, status: 'live' },
      null,
      [],
      'app',
      42,
    ]) {
      expect(appChatThemeState(body)).toBe('unknown');
    }
  });
});

describe('maybePrintThemeHint (guuey#1084)', () => {
  it('prints the two write paths when the app has no chat theme (app.chatTheme: null)', async () => {
    const api = apiReturning({ app: { id: 'app-1', chatTheme: null } });
    const logs: string[] = [];
    await maybePrintThemeHint('pat', CONFIG, 'app-1', { api, log: (l) => logs.push(l) });
    expect(api).toHaveBeenCalledWith('pat', CONFIG, 'GET', '/apps/app-1');
    expect(logs).toEqual(['', ...THEME_HINT_LINES]);
    expect(logs.join('\n')).toContain('Design → Chat theme');
    expect(logs.join('\n')).toContain('guuey agent apply');
  });

  it('is silent when the app has a theme of its own', async () => {
    const logs: string[] = [];
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: apiReturning({ app: { id: 'app-1', chatTheme: { name: 'salon-brand-v2' } } }),
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual([]);
  });

  it('is silent when the body is not the app projection (no app, or chatTheme absent rather than null)', async () => {
    const logs: string[] = [];
    for (const body of [{ applied: true, status: 'live' }, { id: 'app-1', chatTheme: null }, { app: { id: 'app-1' } }]) {
      await maybePrintThemeHint('pat', CONFIG, 'app-1', { api: apiReturning(body), log: (l) => logs.push(l) });
    }
    expect(logs).toEqual([]);
  });

  it('is silent on a non-2xx, a rejected request, or a non-JSON body — never fails the deploy', async () => {
    const logs: string[] = [];
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: apiReturning({ app: { id: 'app-1', chatTheme: null } }, 500),
      log: (l) => logs.push(l),
    });
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: vi.fn(async () => { throw new Error('ECONNRESET'); }),
      log: (l) => logs.push(l),
    });
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: vi.fn(async () => new Response('not json', { status: 200 })),
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual([]);
  });
});
