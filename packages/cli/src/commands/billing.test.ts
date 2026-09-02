/**
 * `guuey billing` + `guuey apps subscribe` (guuey#608) — the cores against a
 * stubbed `apiRequest`, plus the pure renderers. The on-disk cli-wire sync
 * guard for these mirrors lives in `wire-sync.test.ts` beside the others.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokens } from '../auth';
import type { ResolvedConfig } from '../config';
import {
  appsSubscribeCore,
  billingAppRow,
  billingSummaryCore,
  billingTopUpCore,
  BILLING_COLUMNS,
  cardLine,
  creditBalanceLine,
  CREDIT_TOPUP_BUSINESS_USE_LINE,
  CREDIT_TOPUP_REFUND_WORDING,
  type BillingAppWire,
  type BillingSummaryWire,
} from './billing';

const auth: AuthTokens = { pat: 'guuey_user_test', expiresAt: '2099-01-01T00:00:00Z' };
const config: ResolvedConfig = {
  host: 'https://dev.platform.sandbox.guuey.com',
  apiUrl: 'https://api.dev.sandbox.guuey.com/v1',
};

const APP: BillingAppWire = {
  appId: 'app-1',
  displayName: 'Trimly',
  tier: 'pro',
  effectiveTier: 'pro',
  subscriptionStatus: 'active',
  hasSubscription: true,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: '2026-10-01T00:00:00.000Z',
  pendingTier: null,
  pendingChangeAt: null,
  trialStatus: null,
};

const SUMMARY: BillingSummaryWire = {
  ownerType: 'user',
  hasBillingCustomer: true,
  paymentMethodOnFile: { brand: 'visa', last4: '4242' },
  apps: [APP],
  portalHint: true,
  consoleBillingUrl: 'https://dev.platform.sandbox.guuey.com/dashboard/billing',
  creditBalanceUsd: 75,
  topUpAmountsUsd: [25, 50, 100, 250],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cardLine', () => {
  it('renders brand ····last4, or the save-a-card hint', () => {
    expect(cardLine({ brand: 'visa', last4: '4242' })).toBe('Card on file: visa ····4242');
    expect(cardLine(null)).toMatch(/No card on file/);
  });
});

describe('creditBalanceLine (guuey#611)', () => {
  it('prints the balance from the read; unknown prints "—" when lit and NOTHING when dark — never a guessed zero', () => {
    expect(creditBalanceLine({ creditBalanceUsd: 75, topUpAmountsUsd: [25] })).toBe(
      'Credit balance: $75.00 — applies to your next invoices',
    );
    expect(creditBalanceLine({ creditBalanceUsd: 0, topUpAmountsUsd: [] })).toBe(
      'Credit balance: $0.00 — applies to your next invoices',
    );
    expect(creditBalanceLine({ creditBalanceUsd: null, topUpAmountsUsd: [25] })).toBe(
      'Credit balance: — (applies to your next invoices)',
    );
    expect(creditBalanceLine({ creditBalanceUsd: null, topUpAmountsUsd: [] })).toBeNull();
  });
});

describe('billingAppRow', () => {
  it('renders name (id), plan, status, renewal date; quiet Notes when nothing special', () => {
    expect(billingAppRow(APP)).toEqual({
      App: 'Trimly (app-1)',
      Plan: 'pro',
      Status: 'active',
      Renews: '2026-10-01',
      Notes: '—',
    });
    expect(Object.keys(billingAppRow(APP))).toEqual(BILLING_COLUMNS);
  });

  it('surfaces demotion, trial, cancel-at-period-end and pending downgrades in Notes', () => {
    const row = billingAppRow({
      ...APP,
      displayName: null,
      tier: 'starter',
      effectiveTier: 'free', // lapsed → held to free
      subscriptionStatus: 'unpaid',
      cancelAtPeriodEnd: true,
      pendingTier: 'starter',
      pendingChangeAt: '2026-10-01T00:00:00.000Z',
      trialStatus: 'expired',
    });
    expect(row.App).toBe('app-1');
    expect(row.Notes).toBe(
      'trial expired, held to free, cancels at period end, → starter on 2026-10-01',
    );
  });

  it('an unsubscribed app reads free / no subscription', () => {
    const row = billingAppRow({
      ...APP,
      tier: null,
      effectiveTier: 'free',
      subscriptionStatus: null,
      hasSubscription: false,
      currentPeriodEnd: null,
    });
    expect(row.Plan).toBe('free');
    expect(row.Status).toBe('no subscription');
    expect(row.Renews).toBe('—');
  });
});

describe('billingSummaryCore', () => {
  it('GETs /billing and prints the table + card line + console door (or raw JSON)', async () => {
    const api = vi.fn(async () => jsonResponse(200, SUMMARY));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingSummaryCore({ json: false, auth, config }, { api });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'GET', '/billing');
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Trimly (app-1)');
    expect(output).toContain('Card on file: visa ····4242');
    expect(output).toContain(SUMMARY.consoleBillingUrl);

    logSpy.mockClear();
    await billingSummaryCore({ json: true, auth, config }, { api });
    expect(JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''))).toEqual(SUMMARY);
  });

  it('prints the no-apps hint, still shows the card + door, and surfaces API errors', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingSummaryCore(
      { json: false, auth, config },
      { api: vi.fn(async () => jsonResponse(200, { ...SUMMARY, apps: [], paymentMethodOnFile: null })) },
    );
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toMatch(/No apps on this account yet/);
    expect(output).toMatch(/No card on file/);
    await expect(
      billingSummaryCore(
        { json: false, auth, config },
        { api: vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'bad pat' } })) },
      ),
    ).rejects.toThrow(/bad pat/);
  });
});

describe('billingSummaryCore — credits (guuey#611)', () => {
  it('prints the balance line + the topup hint with the SERVER list when lit; neither when dark', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingSummaryCore(
      { json: false, auth, config },
      { api: vi.fn(async () => jsonResponse(200, SUMMARY)) },
    );
    let output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Credit balance: $75.00 — applies to your next invoices');
    expect(output).toContain('--amount <25|50|100|250>');

    logSpy.mockClear();
    await billingSummaryCore(
      { json: false, auth, config },
      {
        api: vi.fn(async () =>
          jsonResponse(200, { ...SUMMARY, creditBalanceUsd: null, topUpAmountsUsd: [] }),
        ),
      },
    );
    output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).not.toMatch(/Credit balance/);
    expect(output).not.toMatch(/billing topup/);
  });
});

describe('billingTopUpCore (guuey#611)', () => {
  it('POSTs /apps/:id/billing/topup with { amountUsd }, prints BOTH ruled lines verbatim, then the Checkout URL, and opens it via the injection-safe opener', async () => {
    const api = vi.fn(async () =>
      jsonResponse(200, { status: 'checkout', url: 'https://checkout.stripe.com/c/topup', ref: 'cs_1' }),
    );
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await billingTopUpCore(
      { appId: 'app-1', amountUsd: 50, openBrowser: true, json: false, auth, config },
      { api, open },
    );
    expect(result).toEqual({ status: 'checkout', url: 'https://checkout.stripe.com/c/topup', ref: 'cs_1' });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'POST', '/apps/app-1/billing/topup', {
      amountUsd: 50,
    });
    const lines = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
    const output = lines.join('\n');
    expect(output).toContain(CREDIT_TOPUP_REFUND_WORDING);
    expect(output).toContain(CREDIT_TOPUP_BUSINESS_USE_LINE);
    expect(CREDIT_TOPUP_REFUND_WORDING).toBe(
      'Credits pre-pay your future guuey invoices and are applied automatically before your card is charged. They are non-refundable and non-transferable, do not expire while your account is open, and any unused balance is forfeited when the account is closed.',
    );
    expect(CREDIT_TOPUP_BUSINESS_USE_LINE).toBe('Business use only');
    // Terms BEFORE the door.
    expect(lines.findIndex((l) => l.includes('non-refundable'))).toBeLessThan(
      lines.findIndex((l) => l.includes('https://checkout.stripe.com/c/topup')),
    );
    expect(output).toContain('$50');
    expect(open).toHaveBeenCalledWith('https://checkout.stripe.com/c/topup');
  });

  it('requires_console prints the console door; --no-browser only prints; --json emits raw', async () => {
    const url = 'https://dev.platform.sandbox.guuey.com/apps/app-1/billing';
    const api = vi.fn(async () => jsonResponse(200, { status: 'requires_console', url, ref: null }));
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingTopUpCore(
      { appId: 'app-1', amountUsd: 25, openBrowser: false, json: false, auth, config },
      { api, open },
    );
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toMatch(/no billing history yet/i);
    expect(output).toContain(url);
    expect(open).not.toHaveBeenCalled();

    logSpy.mockClear();
    await billingTopUpCore(
      { appId: 'app-1', amountUsd: 25, openBrowser: true, json: true, auth, config },
      { api, open },
    );
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''))).toEqual({
      status: 'requires_console',
      url,
      ref: null,
    });
  });

  it("relays the server's faces verbatim — the DARK refusal and the off-list amount", async () => {
    for (const message of [
      'Credit top-ups are not available in this environment.',
      'That amount is not offered — choose one of: $25, $50, $100, $250.',
    ]) {
      await expect(
        billingTopUpCore(
          { appId: 'app-1', amountUsd: 30, openBrowser: false, json: false, auth, config },
          { api: vi.fn(async () => jsonResponse(400, { error: { code: 'VALIDATION', message } })) },
        ),
      ).rejects.toThrow(message);
    }
  });

  it('refuses to open a non-http(s) URL from the server (guuey#500 guard) via the real default opener', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      billingTopUpCore(
        { appId: 'app-1', amountUsd: 25, openBrowser: true, json: false, auth, config },
        {
          api: vi.fn(async () =>
            jsonResponse(200, { status: 'checkout', url: 'javascript:alert(1)', ref: 'cs_x' }),
          ),
        },
      ),
    ).rejects.toThrow(/non-http\(s\)/);
  });
});

describe('appsSubscribeCore', () => {
  it('POSTs /apps/:id/subscribe with { tier } and reports the active outcome', async () => {
    const api = vi.fn(async () => jsonResponse(200, { status: 'active', url: null }));
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await appsSubscribeCore(
      { appId: 'app-1', plan: 'pro', openBrowser: true, json: false, auth, config },
      { api, open },
    );
    expect(result).toEqual({ status: 'active', url: null });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'POST', '/apps/app-1/subscribe', {
      tier: 'pro',
    });
    expect(open).not.toHaveBeenCalled(); // nothing to open on the one-click path
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/saved card/);
  });

  it("reports 'processing' as started-but-settling", async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await appsSubscribeCore(
      { appId: 'app-1', plan: 'starter', openBrowser: true, json: false, auth, config },
      { api: vi.fn(async () => jsonResponse(200, { status: 'processing', url: null })), open: vi.fn(() => true) },
    );
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/still settling/);
  });

  it('requires_checkout prints the URL and opens it via the injection-safe opener; --no-browser only prints', async () => {
    const url = 'https://dev.platform.sandbox.guuey.com/apps/app-1/billing';
    const api = vi.fn(async () => jsonResponse(200, { status: 'requires_checkout', url }));
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await appsSubscribeCore(
      { appId: 'app-1', plan: 'pro', openBrowser: true, json: false, auth, config },
      { api, open },
    );
    expect(open).toHaveBeenCalledWith(url);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(url);

    open.mockClear();
    await appsSubscribeCore(
      { appId: 'app-1', plan: 'pro', openBrowser: false, json: false, auth, config },
      { api, open },
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses to open a non-http(s) URL from the server (guuey#500 guard) via the real default opener', async () => {
    // No `open` injected → the real openUrl default runs; the protocol
    // allowlist throws BEFORE any opener is spawned.
    const api = vi.fn(async () =>
      jsonResponse(200, { status: 'requires_checkout', url: 'javascript:alert(1)' }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(
      appsSubscribeCore(
        { appId: 'app-1', plan: 'pro', openBrowser: true, json: false, auth, config },
        { api },
      ),
    ).rejects.toThrow(/non-http\(s\)/);
  });

  it("relays the API's refusal faces verbatim (allowlist, dup subscription)", async () => {
    await expect(
      appsSubscribeCore(
        { appId: 'app-1', plan: 'pro', openBrowser: false, json: false, auth, config },
        {
          api: vi.fn(async () =>
            jsonResponse(400, {
              error: {
                code: 'VALIDATION',
                message:
                  'This app already has a subscription — change the plan instead of subscribing again.',
              },
            }),
          ),
        },
      ),
    ).rejects.toThrow(/already has a subscription/);
  });

  it('emits raw JSON on --json without opening anything', async () => {
    const open = vi.fn(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await appsSubscribeCore(
      { appId: 'app-1', plan: 'pro', openBrowser: true, json: true, auth, config },
      {
        api: vi.fn(async () => jsonResponse(200, { status: 'requires_checkout', url: 'https://x.example/billing' })),
        open,
      },
    );
    expect(result.status).toBe('requires_checkout');
    expect(open).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join(''))).toEqual({
      status: 'requires_checkout',
      url: 'https://x.example/billing',
    });
  });
});
