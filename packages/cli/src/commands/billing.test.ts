/**
 * `guuey billing` + `guuey apps subscribe` (guuey#608) — the cores against a
 * stubbed `apiRequest`, plus the pure renderers. The on-disk cli-wire sync
 * guard for these mirrors lives in `wire-sync.test.ts` beside the others.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokens } from '../auth';
import type { ResolvedConfig } from '../config';
import {
  billingAutoRechargeCore,
  type AutoRechargeViewWire,
  appsSubscribeCore,
  billingAppRow,
  billingSummaryCore,
  billingTopUpCore,
  BILLING_COLUMNS,
  cardLine,
  bonusCreditLines,
  creditBalanceLine,
  CREDIT_TOPUP_BUSINESS_USE_LINE,
  CREDIT_TOPUP_REFUND_WORDING,
  type BillingAppWire,
  type BillingSummaryWire,
  billingInvoicingCore,
  renderInvoicing,
  invoiceAppRow,
  invoiceHistoryRow,
  usd,
  type BillingInvoicingWire,
  type NextInvoiceWire,
  billingMovementsCore,
  renderMovements,
  type CreditMovementsWire,
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
  bonusBalanceUsd: null,
  activePromotion: null,
  autoRecharge: null,
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

describe('bonusCreditLines (guuey#756 L3)', () => {
  it('prints nothing for a wallet with no bonus and no open promotion — never a bonus sentence to someone who never earned one', () => {
    expect(bonusCreditLines({ bonusBalanceUsd: null, activePromotion: null })).toEqual([]);
    expect(bonusCreditLines({ bonusBalanceUsd: 0, activePromotion: null })).toEqual([]);
  });

  it('prints the balance as usage-only credit, and the open promotion with its rate and end date', () => {
    const promo = {
      id: 'promo_launch',
      rateBps: 1000,
      startsAt: '2026-09-10T00:00:00.000Z',
      endsAt: '2026-10-01T00:00:00.000Z',
      headline: '10 % bonus credit on every top-up',
    };
    expect(bonusCreditLines({ bonusBalanceUsd: 12.5, activePromotion: null })).toEqual([
      'Bonus credit: $12.50 — applied to usage lines on your next invoices, never the plan fee',
    ]);
    expect(bonusCreditLines({ bonusBalanceUsd: null, activePromotion: promo })).toEqual([
      'Top-ups earn a 10% bonus until 2026-10-01 — 10 % bonus credit on every top-up',
    ]);
    // A fractional rate keeps one decimal; both lines print when both exist, balance first.
    expect(bonusCreditLines({ bonusBalanceUsd: 3, activePromotion: { ...promo, rateBps: 1250 } })).toEqual([
      'Bonus credit: $3.00 — applied to usage lines on your next invoices, never the plan fee',
      'Top-ups earn a 12.5% bonus until 2026-10-01 — 10 % bonus credit on every top-up',
    ]);
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
    // Credits are wallet-level (guuey#611): the console door the API hands
    // back is the wallet Billing page, not a per-app one.
    const url = 'https://dev.platform.sandbox.guuey.com/billing';
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
    // What the API returns since guuey#651: the app's Plan & usage page.
    const url = 'https://dev.platform.sandbox.guuey.com/apps/app-1/plan';
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

describe('invoicing (guuey#831)', () => {
  const NEXT: NextInvoiceWire = {
    status: 'preview',
    issuesAt: '2026-10-01T00:00:00.000Z',
    lines: [
      { description: '2 × Pro', quantity: 2, amountUsd: 98, kind: 'plan' },
      { description: 'Managed LLM', quantity: null, amountUsd: 3.5, kind: 'metered' },
    ],
    apps: [
      { appId: 'app-1', displayName: 'Trimly', billedTier: 'pro', planUsd: 49, usageUsd: 2.25, totalUsd: 51.25 },
      { appId: 'app-2', displayName: null, billedTier: 'pro', planUsd: 49, usageUsd: 1.25, totalUsd: 50.25 },
    ],
    accountUsd: 0,
    subtotalUsd: 101.5,
    taxUsd: null,
    totalUsd: 101.5,
    card: { brand: 'visa', last4: '4242' },
  };
  const INVOICING: BillingInvoicingWire = {
    ownerType: 'user',
    ownerId: 'u1',
    hasBillingCustomer: true,
    nextInvoice: NEXT,
    invoices: [
      {
        id: 'in_1',
        number: 'GUUEY-0007',
        createdAt: '2026-09-01T00:00:00.000Z',
        status: 'paid',
        totalUsd: 98,
        amountDueUsd: 0,
        amountPaidUsd: 98,
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/abc',
        invoicePdfUrl: null,
      },
    ],
    invoicesTruncated: true,
    paymentMethods: null,
  };
  const output = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');

  it('row helpers: a purged app reads "(deleted app)", a numberless invoice falls back to its id, a linkless one to —', () => {
    expect(invoiceAppRow(NEXT.apps[1]!)).toEqual({ App: '(deleted app) (app-2)', Plan: 'pro $49.00', Usage: '$1.25', Total: '$50.25' });
    expect(invoiceHistoryRow({ ...INVOICING.invoices![0]!, number: null, hostedInvoiceUrl: null })).toEqual({
      Invoice: 'in_1',
      Date: '2026-09-01',
      Total: '$98.00',
      Due: '$0.00',
      Status: 'paid',
      Link: '—',
    });
  });

  it('usd formats two decimals with the sign before the symbol', () => {
    expect(usd(3.5)).toBe('$3.50');
    expect(usd(-1)).toBe('-$1.00');
    expect(usd(0)).toBe('$0.00');
  });

  it('renders the preview: total + issue date, one row per agent from the SERVER split, the credit note and the card', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderInvoicing(INVOICING, 20);
    const text = output(logSpy);
    expect(text).toContain('Next invoice: $101.50 total on 2026-10-01');
    expect(text).toContain('Trimly (app-1)');
    expect(text).toContain('(deleted app) (app-2)');
    expect(text).toContain('$51.25');
    expect(text).toContain('Credit balance $20.00 applies when the invoice issues');
    expect(text).toContain('Charges: visa ····4242');
    expect(text).toContain('GUUEY-0007');
    expect(text).toContain('https://invoice.stripe.com/i/abc');
    expect(text).toContain('Older invoices: see the billing console.');
    logSpy.mockRestore();
  });

  it('a $0-due month, "none" and "unreadable" each say their own words — never a guessed zero', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderInvoicing({ ...INVOICING, nextInvoice: { ...NEXT, status: 'none', lines: [], apps: [], totalUsd: null } }, null);
    expect(output(logSpy)).toContain('Next invoice: none — the subscription ends at the period end.');
    logSpy.mockClear();
    renderInvoicing(
      { ...INVOICING, nextInvoice: { ...NEXT, status: 'unreadable', lines: [], apps: [], totalUsd: null, subtotalUsd: null }, invoices: null },
      null,
    );
    const t = output(logSpy);
    expect(t).toContain("Next invoice: couldn't be read from Stripe right now");
    expect(t).toContain("Invoice history: couldn't be read from Stripe right now.");
    expect(t).not.toContain('$0.00');
    logSpy.mockClear();
    renderInvoicing({ ...INVOICING, hasBillingCustomer: false, nextInvoice: null, invoices: [] }, 50);
    expect(output(logSpy)).toBe('  Invoices: nothing billed on this account yet.');
    logSpy.mockRestore();
  });

  it('billingInvoicingCore GETs /billing/invoicing; --json emits the wire verbatim; an API error surfaces its message', async () => {
    const api = vi.fn(async () => jsonResponse(200, INVOICING));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingInvoicingCore({ json: true, auth, config }, { api });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'GET', '/billing/invoicing');
    expect(JSON.parse(output(logSpy))).toEqual(INVOICING);
    await expect(
      billingInvoicingCore(
        { json: false, auth, config },
        { api: vi.fn(async () => jsonResponse(503, { error: { code: 'STRIPE_UNAVAILABLE', message: 'stripe down' } })) },
      ),
    ).rejects.toThrow(/stripe down/);
    logSpy.mockRestore();
  });

  it('the summary reads /billing then /billing/invoicing; a failing second read is ONE honest line and the door still prints', async () => {
    const api = vi.fn(async (_pat: string, _cfg: unknown, _m: string, path: string) =>
      path === '/billing' ? jsonResponse(200, SUMMARY) : jsonResponse(500, { error: { code: 'INTERNAL', message: 'boom' } }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingSummaryCore({ json: false, auth, config }, { api });
    const paths = api.mock.calls.map((c) => c[3]);
    expect(paths).toEqual(['/billing', '/billing/invoicing']);
    const text = output(logSpy);
    expect(text).toContain("Invoices: couldn't be read right now (");
    expect(text).toContain(SUMMARY.consoleBillingUrl);
    logSpy.mockRestore();
  });
});

describe('guuey billing auto-recharge (guuey#756 L2) — the CLI face of setAutoRecharge', () => {
  const VIEW_ON: AutoRechargeViewWire = {
    enabled: true,
    thresholdUsd: 20,
    amountUsd: 25,
    monthlyCapUsd: 200,
    consentAt: '2026-09-06T07:00:00.000Z',
    consentLast4: '4242',
    monthUsd: 50,
    lastAttemptAt: null,
    lastAttemptOutcome: null,
    lastAttemptDeclineCode: null,
    lastAttemptRef: null,
    inFlightRef: null,
    receiptEmails: true,
    lastHold: null,
    lastHoldSentence: null,
  };
  const CONSENT = {
    textVersion: '2026-09-04-amendment-D2-v1',
    creditOptIn: 'Prepaid credit is optional…',
    autoRechargeOptIn: 'When your balance would fall under $20 we charge your Visa ····4242 $25…',
    card: { brand: 'visa', last4: '4242' },
  };
  afterEach(() => vi.restoreAllMocks());

  it('show: reads the summary and prints the off line with the how-to when nothing is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = vi.fn(async () => jsonResponse(200, SUMMARY));
    await billingAutoRechargeCore({ action: { kind: 'show' }, workspaceId: null, yes: false, json: false, auth, config }, { api });
    expect(api).toHaveBeenCalledWith(auth.pat, config, 'GET', '/billing');
    expect(log.mock.calls.flat().join('\n')).toContain('Auto-recharge: off — guuey billing auto-recharge --on');
  });

  it('--on: shows BOTH consent paragraphs from the API, asks for a typed yes, then PUTs the settings with the version it showed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const api = vi.fn(async (_pat: string, _cfg: unknown, method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === 'GET') return jsonResponse(200, CONSENT);
      return jsonResponse(200, { autoRecharge: VIEW_ON });
    });
    const confirm = vi.fn(async () => true);
    await billingAutoRechargeCore(
      { action: { kind: 'on', thresholdUsd: 20, amountUsd: 25, monthlyCapUsd: 200, receiptEmails: true }, workspaceId: null, yes: false, json: false, auth, config },
      { api, confirm },
    );
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/billing/auto-recharge/consent?thresholdUsd=20&amountUsd=25&monthlyCapUsd=200' });
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain(CONSENT.creditOptIn);
    expect(printed).toContain(CONSENT.autoRechargeOptIn);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual({
      method: 'PUT',
      path: '/billing/auto-recharge',
      body: { enabled: true, thresholdUsd: 20, amountUsd: 25, monthlyCapUsd: 200, receiptEmails: true, consentTextVersion: CONSENT.textVersion },
    });
    expect(printed).toContain('Auto-recharge: on — adds $25 of credit when the balance would fall under $20; cap $200/month ($50 used this month)');
  });

  it('--on without the typed yes writes NOTHING; --yes skips the prompt; --workspace rides the query on both calls', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = vi.fn(async (_p: string, _c: unknown, method: string, _path?: string, _body?: unknown) =>
      method === 'GET' ? jsonResponse(200, CONSENT) : jsonResponse(200, { autoRecharge: VIEW_ON }),
    );
    await billingAutoRechargeCore(
      { action: { kind: 'on', thresholdUsd: 20, amountUsd: 25, monthlyCapUsd: 200, receiptEmails: null }, workspaceId: null, yes: false, json: false, auth, config },
      { api, confirm: async () => false },
    );
    expect(api.mock.calls.map((c) => c[2])).toEqual(['GET']);
    api.mockClear();
    await billingAutoRechargeCore(
      { action: { kind: 'on', thresholdUsd: 20, amountUsd: 25, monthlyCapUsd: 200, receiptEmails: null }, workspaceId: 'ws-1', yes: true, json: true, auth, config },
      {
        api,
        confirm: async () => {
          throw new Error('prompt must not run with --yes');
        },
      },
    );
    expect(api.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['GET', '/billing/auto-recharge/consent?thresholdUsd=20&amountUsd=25&monthlyCapUsd=200&workspaceId=ws-1'],
      ['PUT', '/billing/auto-recharge?workspaceId=ws-1'],
    ]);
    expect(api.mock.calls[1]?.[4]).not.toHaveProperty('receiptEmails');
  });

  it('--off PUTs { enabled: false } with no consent round-trip; an API refusal surfaces its sentence', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const api = vi.fn(async () => jsonResponse(200, { autoRecharge: { ...VIEW_ON, enabled: false } }));
    await billingAutoRechargeCore({ action: { kind: 'off' }, workspaceId: null, yes: false, json: false, auth, config }, { api });
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(auth.pat, config, 'PUT', '/billing/auto-recharge', { enabled: false });
    const refused = vi.fn(async () =>
      jsonResponse(400, { error: { code: 'VALIDATION', message: 'Auto-recharge needs a saved card — add one in Billing, then turn it on.' } }),
    );
    await expect(
      billingAutoRechargeCore({ action: { kind: 'off' }, workspaceId: null, yes: false, json: false, auth, config }, { api: refused }),
    ).rejects.toThrow(/needs a saved card/);
  });
});

describe('guuey billing movements — paid vs bonus credit movements (guuey#795 2c)', () => {
  // The file's `output` helper is scoped to an earlier describe — the same shape, locally.
  const movementsOutput = (spy: { mock: { calls: unknown[][] } }): string =>
    spy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  const MOVEMENTS: CreditMovementsWire = {
    paidSide: 'read',
    truncated: false,
    movements: [
      { at: '2026-09-05T10:00:00.000Z', source: 'bonus', kind: 'draw', amountUsd: -3, stripeObjectId: 'in_2', invoiceId: 'in_2', description: 'Bonus credit applied to usage' },
      { at: '2026-09-01T10:00:00.000Z', source: 'paid', kind: 'top-up', amountUsd: 25, stripeObjectId: 'cbtxn_1', invoiceId: null, description: 'guuey credits — $25 top-up (pre-pays future invoices)' },
    ],
  };

  it('billingMovementsCore GETs /billing/credit-movements; --json emits the wire verbatim; an API error surfaces its message', async () => {
    const api = vi.fn(async () => jsonResponse(200, MOVEMENTS));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await billingMovementsCore({ json: true, auth, config }, { api });
    expect(api).toHaveBeenCalledWith('guuey_user_test', config, 'GET', '/billing/credit-movements');
    expect(JSON.parse(movementsOutput(logSpy))).toEqual(MOVEMENTS);
    await expect(
      billingMovementsCore(
        { json: false, auth, config },
        { api: vi.fn(async () => jsonResponse(503, { error: { code: 'STRIPE_UNAVAILABLE', message: 'stripe down' } })) },
      ),
    ).rejects.toThrow(/stripe down/);
    logSpy.mockRestore();
  });

  it('renderMovements: one row per movement newest-first — date, Paid/Bonus, what, a signed amount, the invoice', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderMovements(MOVEMENTS);
    const t = movementsOutput(logSpy);
    expect(t.indexOf('Bonus applied to usage')).toBeLessThan(t.indexOf('Credits purchased'));
    expect(t).toContain('-$3.00');
    expect(t).toContain('$25.00');
    expect(t).toContain('in_2');
    expect(t).toContain('2026-09-05');
    expect(t).not.toMatch(/couldn't be read|latest 50/);
    logSpy.mockRestore();
  });

  it('renderMovements: says when the paid side could not be read, when the page is cut, and when there is nothing yet', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderMovements({ ...MOVEMENTS, paidSide: 'unreadable' });
    expect(movementsOutput(logSpy)).toContain("couldn't be read");
    logSpy.mockClear();
    renderMovements({ ...MOVEMENTS, truncated: true });
    expect(movementsOutput(logSpy)).toContain('latest 50');
    logSpy.mockClear();
    renderMovements({ movements: [], truncated: false, paidSide: 'no-customer' });
    expect(movementsOutput(logSpy).trim()).toBe('No credit movements yet.');
    logSpy.mockRestore();
  });
});
