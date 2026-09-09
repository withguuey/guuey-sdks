import { describe, expect, it, vi } from 'vitest';
import { maybePrintThemeHint, THEME_HINT_LINES } from './theme-hint';

function apiReturning(body: unknown, ok = true) {
  return vi.fn(async () =>
    ({ ok, json: async () => body }) as unknown as Response,
  );
}

const CONFIG = { apiUrl: 'https://api.guuey.test/v1' };

describe('maybePrintThemeHint (guuey#1084)', () => {
  it('prints the two write paths when the app has no chat theme (chatTheme: null)', async () => {
    const api = apiReturning({ id: 'app-1', chatTheme: null });
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
      api: apiReturning({ id: 'app-1', chatTheme: { name: 'salon-brand-v2' } }),
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual([]);
  });

  it('is silent when the body is not the app projection (chatTheme absent, not null)', async () => {
    const logs: string[] = [];
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: apiReturning({ applied: true, status: 'live' }),
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual([]);
  });

  it('is silent on a non-2xx, a rejected request, or a non-JSON body — never fails the deploy', async () => {
    const logs: string[] = [];
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: apiReturning({ chatTheme: null }, false),
      log: (l) => logs.push(l),
    });
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: vi.fn(async () => { throw new Error('ECONNRESET'); }),
      log: (l) => logs.push(l),
    });
    await maybePrintThemeHint('pat', CONFIG, 'app-1', {
      api: vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }) as unknown as Response),
      log: (l) => logs.push(l),
    });
    expect(logs).toEqual([]);
  });
});
