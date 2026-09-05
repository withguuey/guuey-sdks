/**
 * `guuey billing` + `guuey apps subscribe` — the CLI half of
 * payment-method-on-file one-click subscribe (guuey#608):
 *
 *   billing                              plan per app + the wallet's saved
 *                                        card (····last4) + the credit
 *                                        balance + the console billing door
 *   billing topup --app <id> --amount <usd>
 *                                        credit top-up (guuey#611): prints
 *                                        the founder-signed terms and the
 *                                        hosted Checkout URL for an
 *                                        allowlisted amount; the webhook
 *                                        credits the balance on completion
 *   apps subscribe <appId> --plan <tier> one-click subscribe against the
 *                                        saved card; falls back to a
 *                                        browser checkout URL when there is
 *                                        no usable card
 *
 * The server owns everything money-shaped: the tier resolves to a Stripe
 * price against the environment's allowlist SERVER-SIDE (no price id or
 * amount ever lives in the CLI), the charged card is server-resolved, and
 * subscription truth lands via Stripe's webhook — a success line here means
 * "Stripe accepted it", never "we marked it locally".
 *
 * Wire shapes are hand-mirrored from `@guuey-private/cli-wire`
 * (`billing.ts`) and pinned by `wire-sync.test.ts` — see
 * `../wire-mirror-parse.ts` for why the CLI mirrors instead of importing.
 */
import { requireAuth, type AuthTokens } from '../auth';
import { resolveConfig, type ResolvedConfig } from '../config';
import { apiRequest, parseApiError } from '../deploy-shared';
import { openUrl } from '../open-url';
import * as out from '../output';

// ─── Wire mirrors (SYNC: backend/libs/cli-wire/billing.ts) ────────────

/** Mirror of `PaymentMethodOnFileWire`. */
export interface PaymentMethodOnFileWire {
  brand: string;
  last4: string;
}

/** Mirror of `BillingAppWire` (statuses widened to string so a future one prints verbatim). */
export interface BillingAppWire {
  appId: string;
  displayName: string | null;
  tier: string | null;
  effectiveTier: string;
  subscriptionStatus: string | null;
  hasSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  pendingTier: string | null;
  pendingChangeAt: string | null;
  trialStatus: string | null;
}

/** Mirror of `BillingSummaryWire`. */
export interface BillingSummaryWire {
  ownerType: string;
  hasBillingCustomer: boolean;
  paymentMethodOnFile: PaymentMethodOnFileWire | null;
  apps: BillingAppWire[];
  portalHint: boolean;
  consoleBillingUrl: string;
  /** guuey#611 — the wallet's credit balance (USD); null = unknown. */
  creditBalanceUsd: number | null;
  /** guuey#611 — the env's top-up allowlist; empty = top-ups are dark here. */
  topUpAmountsUsd: number[];
}

/** Mirror of `SubscribeAppResultWire`. */
export interface SubscribeAppResultWire {
  status: string;
  url: string | null;
}

/** Mirror of `CreditTopUpResultWire` (guuey#611; status widened to string). */
export interface CreditTopUpResultWire {
  status: string;
  url: string;
  ref: string | null;
}

// ─── Founder-signed top-up copy (guuey#611) — VERBATIM on every top-up surface ──

/** The refund policy, word for word as ruled 2026-09-02. */

// ─── Wire mirrors (SYNC: backend/libs/cli-wire/billing-invoicing.ts) ──────
// `guuey billing` renders the wallet's next invoice + issued history from
// `GET /billing/invoicing` (guuey#831). Field-exact copies, pinned by
// `wire-sync.test.ts`; the doc comments are the wire's own.

export type NextInvoiceLineKind = 'plan' | 'metered' | 'proration' | 'other';

export interface NextInvoiceLineWire {
  /** Stripe `line.description` — Stripe's own wording, verbatim. */
  description: string | null;
  /** Stripe `line.quantity`; null when Stripe reports none. */
  quantity: number | null;
  /** Stripe `line.amount` / 100 — negative on a proration credit. */
  amountUsd: number;
  kind: NextInvoiceLineKind;
}

export interface NextInvoiceAppShareWire {
  appId: string;
  /** `GuueyApp.name` at read time; null when the app row is gone (purged). */
  displayName: string | null;
  /** The tier this agent is BILLED at next invoice (`pendingTier ?? tier`). */
  billedTier: string | null;
  /** This agent's share of the plan lines, USD. */
  planUsd: number;
  /** This agent's share of the metered lines, USD. */
  usageUsd: number;
  /** `planUsd + usageUsd`. */
  totalUsd: number;
}

export type NextInvoiceStatus = 'preview' | 'none' | 'unreadable';

export interface NextInvoiceWire {
  status: NextInvoiceStatus;
  /**
   * When Stripe will issue it — the invoice's `period_end` (the end of the
   * period whose usage it itemizes = the subscription's renewal), ISO. Null
   * unless `status === 'preview'`.
   */
  issuesAt: string | null;
  /** Stripe `invoice.lines.data`, projected; empty unless `preview`. */
  lines: NextInvoiceLineWire[];
  /** Guuey's per-agent split of those lines; empty unless `preview`. */
  apps: NextInvoiceAppShareWire[];
  /**
   * The part of the invoice that belongs to no single agent — prorations,
   * discounts, and any usage our ledger could not attribute. USD, and
   * `apps` + this equals the subtotal exactly.
   */
  accountUsd: number;
  /** Stripe `invoice.subtotal` / 100 — before tax and before credits. */
  subtotalUsd: number | null;
  /** Stripe `invoice.tax` / 100; null when Stripe computes none. */
  taxUsd: number | null;
  /**
   * Stripe `invoice.total` / 100 — after tax and discounts, BEFORE the
   * customer balance (credits) is applied. Credits net against the wallet's
   * invoices in issue order, which is why the per-invoice "after credits"
   * figure is deliberately NOT on this wire (each isolated preview would
   * show the whole balance applied to itself; summing those would claim
   * the credit twice).
   */
  totalUsd: number | null;
  /**
   * The card THIS invoice would charge: the subscription's own
   * `default_payment_method` when it is a card (Checkout stamps the card
   * there), else the wallet's effective card (see `WalletCardWire.isDefault`).
   * Null = no card resolvable — the invoice would go unpaid until one is
   * added.
   */
  card: PaymentMethodOnFileWire | null;
}

export type InvoiceHistoryStatus = 'open' | 'paid' | 'uncollectible' | 'void';

export interface InvoiceHistoryEntryWire {
  /** Stripe `invoice.id` (`in_…`) — a stable key, not a secret. */
  id: string;
  /** Stripe `invoice.number` (`ABCD-0001`); null if Stripe assigned none. */
  number: string | null;
  /** Stripe `invoice.created`, ISO. */
  createdAt: string;
  status: InvoiceHistoryStatus;
  /** Stripe `invoice.total` / 100. */
  totalUsd: number;
  /** Stripe `invoice.amount_due` / 100 — after credits; 0 once paid or when credits covered it. */
  amountDueUsd: number;
  /** Stripe `invoice.amount_paid` / 100. */
  amountPaidUsd: number;
  /** Stripe `invoice.hosted_invoice_url` — Stripe's own page for it. */
  hostedInvoiceUrl: string | null;
  /** Stripe `invoice.invoice_pdf` — the PDF download. */
  invoicePdfUrl: string | null;
}

export interface WalletCardWire {
  /** Stripe `payment_method.card.brand` (`visa`, `mastercard`, …). */
  brand: string;
  /** Stripe `payment_method.card.last4`. */
  last4: string;
  /** Stripe `payment_method.card.exp_month` (1–12). */
  expMonth: number;
  /** Stripe `payment_method.card.exp_year` (four digits). */
  expYear: number;
  /**
   * This is the card an off-session charge would use — the SAME resolution
   * every one-click subscribe reads (`shared/stripe-saved-card.ts#
   * resolveEffectivePaymentMethod`: the customer's explicit default, else
   * the newest attached card). At most one entry is true.
   */
  isDefault: boolean;
}

export interface BillingInvoicingWire {
  ownerType: 'user' | 'workspace';
  ownerId: string;
  /** A Stripe customer exists for this wallet (false = nothing ever billed; every list below is empty). */
  hasBillingCustomer: boolean;
  /**
   * The wallet's ONE next invoice (guuey#799). Null when the wallet holds no
   * subscription at all — nothing is coming, which is a state, not a failure.
   */
  nextInvoice: NextInvoiceWire | null;
  /** Issued invoices, newest first; null = Stripe unreadable. */
  invoices: InvoiceHistoryEntryWire[] | null;
  /** Stripe's `has_more` for the list above — older invoices exist beyond the page. */
  invoicesTruncated: boolean;
  /** Cards on the wallet's customer, newest first; null = Stripe unreadable. */
  paymentMethods: WalletCardWire[] | null;
}

export const CREDIT_TOPUP_REFUND_WORDING =
  'Credits pre-pay your future guuey invoices and are applied automatically before your card is charged. They are non-refundable and non-transferable, do not expire while your account is open, and any unused balance is forfeited when the account is closed.';

/** The separate belt line, word for word. */
export const CREDIT_TOPUP_BUSINESS_USE_LINE = 'Business use only';

/**
 * Mirror of `SUBSCRIBABLE_TIERS` — the plan NAMES only. The server maps a
 * name to its Stripe price against the environment allowlist; an off-list
 * name is refused there too, so this local list is a usage nicety, not the
 * gate.
 */
export const SUBSCRIBABLE_TIERS = ['starter', 'pro', 'scale'] as const;

// ─── Rendering (pure, unit-pinned) ────────────────────────────────────

export const BILLING_COLUMNS = ['App', 'Plan', 'Status', 'Renews', 'Notes'];

/** `visa ····4242` — the only card facts that ever reach the CLI. */
export function cardLine(pm: PaymentMethodOnFileWire | null): string {
  return pm
    ? `Card on file: ${pm.brand} ····${pm.last4}`
    : 'No card on file — your first checkout (browser) saves one for one-click subscribes.';
}

/**
 * The credit balance line (guuey#611), from the READ only. Null (unknown /
 * never billed) prints nothing when top-ups are dark, and an honest "—" when
 * they are lit — never a guessed zero.
 */
export function creditBalanceLine(summary: {
  creditBalanceUsd: number | null;
  topUpAmountsUsd: number[];
}): string | null {
  if (summary.creditBalanceUsd === null) {
    return summary.topUpAmountsUsd.length > 0
      ? 'Credit balance: — (applies to your next invoices)'
      : null;
  }
  return `Credit balance: $${summary.creditBalanceUsd.toFixed(2)} — applies to your next invoices`;
}

/** One `guuey billing` table row. */
export function billingAppRow(app: BillingAppWire): Record<string, string> {
  const notes: string[] = [];
  if (app.trialStatus === 'active') notes.push('trial');
  if (app.trialStatus === 'expired') notes.push('trial expired');
  if (app.tier !== null && app.effectiveTier !== app.tier) {
    // A lapsed subscription is HELD to free — say so where the plan column
    // would otherwise overpromise.
    notes.push(`held to ${app.effectiveTier}`);
  }
  if (app.cancelAtPeriodEnd) notes.push('cancels at period end');
  if (app.pendingTier) {
    notes.push(
      `→ ${app.pendingTier}${app.pendingChangeAt ? ` on ${app.pendingChangeAt.slice(0, 10)}` : ''}`,
    );
  }
  return {
    App: app.displayName ? `${app.displayName} (${app.appId})` : app.appId,
    Plan: app.tier ?? 'free',
    Status: app.subscriptionStatus ?? (app.hasSubscription ? '—' : 'no subscription'),
    Renews: app.currentPeriodEnd ? app.currentPeriodEnd.slice(0, 10) : '—',
    Notes: notes.length > 0 ? notes.join(', ') : '—',
  };
}

// ─── Cores (testable; `deps.api` is the injection seam) ────────────────


// ─── Invoicing render (guuey#831) ──────────────────────────────────────
export const INVOICE_APP_COLUMNS = ['App', 'Plan', 'Usage', 'Total'];
export const INVOICE_HISTORY_COLUMNS = ['Invoice', 'Date', 'Total', 'Due', 'Status', 'Link'];

/** `$12.34` — two decimals, a leading minus on a credit (never `$-1.00`). */
export function usd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

const isoDay = (iso: string): string => iso.slice(0, 10);

/** One agent's share row — the server's split, never re-derived here. */
export function invoiceAppRow(share: NextInvoiceAppShareWire): Record<string, string> {
  return {
    App: `${share.displayName ?? '(deleted app)'} (${share.appId})`,
    Plan: share.billedTier ? `${share.billedTier} ${usd(share.planUsd)}` : usd(share.planUsd),
    Usage: usd(share.usageUsd),
    Total: usd(share.totalUsd),
  };
}

export function invoiceHistoryRow(inv: InvoiceHistoryEntryWire): Record<string, string> {
  return {
    Invoice: inv.number ?? inv.id,
    Date: isoDay(inv.createdAt),
    Total: usd(inv.totalUsd),
    Due: usd(inv.amountDueUsd),
    Status: inv.status,
    Link: inv.hostedInvoiceUrl ?? '—',
  };
}

/**
 * The lines `guuey billing` prints for the wallet's invoicing position.
 * Every Stripe-backed section degrades on its own words — "couldn't be read"
 * is a state the wire carries (`unreadable` / `null`), never a zero — and
 * the after-credits figure is deliberately absent (the wire's own rule: an
 * isolated preview cannot know how much of the balance it will get), so the
 * credit note names the balance the summary already read and says WHEN it
 * applies.
 */
export function renderInvoicing(
  data: BillingInvoicingWire,
  creditBalanceUsd: number | null,
): void {
  if (!data.hasBillingCustomer) {
    console.log('  Invoices: nothing billed on this account yet.');
    return;
  }
  const next = data.nextInvoice;
  if (next === null) {
    console.log('  Next invoice: none — no subscription on this account.');
  } else if (next.status === 'none') {
    console.log('  Next invoice: none — the subscription ends at the period end.');
  } else if (next.status === 'unreadable') {
    console.log("  Next invoice: couldn't be read from Stripe right now — try again in a minute.");
  } else {
    const when = next.issuesAt ? ` on ${isoDay(next.issuesAt)}` : '';
    const total = next.totalUsd === null ? 'total unreadable' : `${usd(next.totalUsd)} total`;
    const tax = next.taxUsd !== null && next.taxUsd !== 0 ? ` (incl. ${usd(next.taxUsd)} tax)` : '';
    console.log(`  Next invoice: ${total}${when}${tax}`);
    if (next.apps.length > 0) {
      out.table(next.apps.map(invoiceAppRow), INVOICE_APP_COLUMNS);
    }
    if (next.accountUsd !== 0) {
      console.log(`  Account (prorations, discounts, unattributed usage): ${usd(next.accountUsd)}`);
    }
    if (creditBalanceUsd !== null && creditBalanceUsd > 0) {
      console.log(
        `  Credit balance ${usd(creditBalanceUsd)} applies when the invoice issues — the card is charged the remainder, if any.`,
      );
    }
    if (next.card) {
      console.log(`  Charges: ${next.card.brand} ····${next.card.last4}`);
    } else {
      console.log('  Charges: no card resolvable — the invoice would go unpaid until one is added.');
    }
  }
  if (data.invoices === null) {
    console.log("  Invoice history: couldn't be read from Stripe right now.");
  } else if (data.invoices.length === 0) {
    console.log('  Invoice history: none issued yet.');
  } else {
    console.log('  Recent invoices:');
    out.table(data.invoices.map(invoiceHistoryRow), INVOICE_HISTORY_COLUMNS);
    if (data.invoicesTruncated) {
      console.log('  Older invoices: see the billing console.');
    }
  }
}

/** `guuey billing invoice [--json]` — the invoicing wire, rendered or raw. */
export async function billingInvoicingCore(
  opts: { json: boolean; auth: AuthTokens; config: ResolvedConfig; creditBalanceUsd?: number | null },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(opts.auth.pat, opts.config, 'GET', '/billing/invoicing');
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as BillingInvoicingWire;
  if (opts.json) {
    out.json(data);
    return;
  }
  renderInvoicing(data, opts.creditBalanceUsd ?? null);
}

export async function billingSummaryCore(
  opts: { json: boolean; auth: AuthTokens; config: ResolvedConfig },
  deps?: { api?: typeof apiRequest },
): Promise<void> {
  const api = deps?.api ?? apiRequest;
  const res = await api(opts.auth.pat, opts.config, 'GET', '/billing');
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as BillingSummaryWire;
  if (opts.json) {
    out.json(data);
    return;
  }
  if (data.apps.length === 0) {
    console.log('  No apps on this account yet — "guuey apps create" starts one.');
  } else {
    out.table(data.apps.map(billingAppRow), BILLING_COLUMNS);
  }
  console.log('');
  console.log(`  ${cardLine(data.paymentMethodOnFile)}`);
  const credit = creditBalanceLine(data);
  if (credit !== null) {
    console.log(`  ${credit}`);
    if (data.topUpAmountsUsd.length > 0) {
      console.log(
        `  Add credits: guuey billing topup --app <appId> --amount <${data.topUpAmountsUsd.join('|')}>`,
      );
    }
  }
  // guuey#831: the wallet's next invoice + issued history — a SECOND read
  // that must never cost the reader the summary above: any failure is one
  // honest line, and the console door still prints.
  console.log('');
  try {
    await billingInvoicingCore(
      { json: false, auth: opts.auth, config: opts.config, creditBalanceUsd: data.creditBalanceUsd ?? null },
      { api },
    );
  } catch (err) {
    console.log(`  Invoices: couldn't be read right now (${err instanceof Error ? err.message : String(err)}).`);
  }
  // portalHint: the server mints no Stripe portal session on this wire —
  // the console Billing page (a real, env-correct link) is the door for
  // invoices, cards and cancellations.
  console.log(`  Manage invoices & payment methods: ${data.consoleBillingUrl}`);
}

export async function billingTopUpCore(
  opts: {
    appId: string;
    amountUsd: number;
    openBrowser: boolean;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest; open?: (url: string) => boolean },
): Promise<CreditTopUpResultWire> {
  const api = deps?.api ?? apiRequest;
  // openUrl refuses (throws) a non-http(s) url — the value is
  // server-supplied, so anything malformed is surfaced, never opened
  // (the guuey#500 injection guard).
  const open = deps?.open ?? openUrl;
  const res = await api(
    opts.auth.pat,
    opts.config,
    'POST',
    `/apps/${encodeURIComponent(opts.appId)}/billing/topup`,
    { amountUsd: opts.amountUsd },
  );
  if (!res.ok) {
    // The server's faces come through verbatim: the dark refusal ("not
    // available in this environment"), the off-list amount naming the
    // offered list, the ownership refusals.
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as CreditTopUpResultWire;
  if (opts.json) {
    out.json(data);
    return data;
  }
  // The top-up surface carries the founder-signed wording, verbatim, before
  // the door — the customer reads the terms before they pay.
  console.log(`  ${CREDIT_TOPUP_REFUND_WORDING}`);
  console.log(`  ${CREDIT_TOPUP_BUSINESS_USE_LINE}`);
  console.log('');
  if (data.status === 'requires_console') {
    console.log(
      `This account has no billing history yet — start your first purchase from the console Billing page:`,
    );
  } else {
    console.log(
      `Pay $${opts.amountUsd} of credits in the browser (nothing is charged until you complete Checkout; ` +
        'the balance updates once Stripe confirms):',
    );
  }
  console.log(`  ${data.url}`);
  if (opts.openBrowser) {
    const opened = open(data.url);
    console.log(opened ? 'Opening your browser…' : "Couldn't open a browser — copy the URL above.");
  }
  return data;
}

export async function appsSubscribeCore(
  opts: {
    appId: string;
    plan: string;
    openBrowser: boolean;
    json: boolean;
    auth: AuthTokens;
    config: ResolvedConfig;
  },
  deps?: { api?: typeof apiRequest; open?: (url: string) => boolean },
): Promise<SubscribeAppResultWire> {
  const api = deps?.api ?? apiRequest;
  // openUrl refuses (throws) a non-http(s) url — the value is
  // server-supplied, so anything malformed is surfaced, never opened
  // (the guuey#500 injection guard).
  const open = deps?.open ?? openUrl;
  const res = await api(
    opts.auth.pat,
    opts.config,
    'POST',
    `/apps/${encodeURIComponent(opts.appId)}/subscribe`,
    { tier: opts.plan },
  );
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => ({}));
    throw new Error(parseApiError(data, `HTTP ${res.status}`));
  }
  const data = (await res.json()) as SubscribeAppResultWire;
  if (opts.json) {
    out.json(data);
    return data;
  }
  if (data.status === 'active') {
    out.success(
      `Subscribed ${opts.appId} to the ${opts.plan} plan using your saved card. ` +
        'The billing record updates as soon as Stripe confirms (moments).',
    );
    return data;
  }
  if (data.status === 'processing') {
    out.success(
      `Subscription for ${opts.appId} (${opts.plan}) started — the first payment is still settling. ` +
        '"guuey billing" shows it once Stripe confirms.',
    );
    return data;
  }
  // requires_checkout — no usable saved card (or it was declined): finish
  // in the browser, where a card can be entered/authenticated.
  console.log(`No usable saved card — finish subscribing ${opts.appId} (${opts.plan}) in the browser:`);
  console.log(`  ${data.url ?? '(no URL returned)'}`);
  if (data.url && opts.openBrowser) {
    const opened = open(data.url);
    console.log(opened ? 'Opening your browser…' : "Couldn't open a browser — copy the URL above.");
  }
  return data;
}

// ─── Command entrypoints ───────────────────────────────────────────────

/** `guuey billing [--json]` */
export async function billing(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  try {
    await billingSummaryCore({ json: flags?.json === true, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** `guuey billing invoice [--json]` (guuey#831) — the wallet's next invoice + issued history, alone. */
export async function billingInvoice(flags?: Record<string, string | true>): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  try {
    await billingInvoicingCore({ json: flags?.json === true, auth, config });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** `guuey billing topup --app <appId> --amount <usd> [--no-browser] [--json]` (guuey#611) */
export async function billingTopUp(flags?: Record<string, string | true>): Promise<void> {
  const config = resolveConfig();
  const appFlag = flags?.app;
  const appId = typeof appFlag === 'string' && appFlag.length > 0 ? appFlag : config.appId;
  if (!appId) {
    out.error('Usage: guuey billing topup --app <appId> --amount <usd>');
    process.exit(1);
  }
  const amountFlag = flags?.amount;
  // A whole-dollar integer — the SERVER decides whether it is one of the
  // offered amounts (its allowlist), and says which are, so the CLI carries
  // no list of its own.
  const amountUsd =
    typeof amountFlag === 'string' && /^[1-9]\d*$/.test(amountFlag.trim())
      ? Number(amountFlag.trim())
      : null;
  if (amountUsd === null) {
    out.error('--amount is required — a whole-dollar amount, e.g. --amount 50');
    process.exit(1);
  }
  const auth = requireAuth();
  try {
    await billingTopUpCore({
      appId,
      amountUsd,
      openBrowser: flags?.['no-browser'] !== true,
      json: flags?.json === true,
      auth,
      config,
    });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** `guuey apps subscribe <appId> --plan <tier> [--no-browser] [--json]` */
export async function appsSubscribe(
  appId?: string,
  flags?: Record<string, string | true>,
): Promise<void> {
  const config = resolveConfig();
  const resolved = appId ?? config.appId;
  if (!resolved) {
    out.error('Usage: guuey apps subscribe <appId> --plan <starter|pro|scale>');
    process.exit(1);
  }
  const plan = flags?.plan;
  if (typeof plan !== 'string' || plan.length === 0) {
    out.error(`--plan is required — one of: ${SUBSCRIBABLE_TIERS.join(', ')}`);
    process.exit(1);
  }
  if (!(SUBSCRIBABLE_TIERS as readonly string[]).includes(plan)) {
    out.error(`Unknown plan '${plan}' — one of: ${SUBSCRIBABLE_TIERS.join(', ')}`);
    process.exit(1);
  }
  const auth = requireAuth();
  try {
    await appsSubscribeCore({
      appId: resolved,
      plan,
      openBrowser: flags?.['no-browser'] !== true,
      json: flags?.json === true,
      auth,
      config,
    });
  } catch (err) {
    out.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
