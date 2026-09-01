/**
 * `guuey billing` + `guuey apps subscribe` — the CLI half of
 * payment-method-on-file one-click subscribe (guuey#608):
 *
 *   billing                              plan per app + the wallet's saved
 *                                        card (····last4) + the console
 *                                        billing door
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
}

/** Mirror of `SubscribeAppResultWire`. */
export interface SubscribeAppResultWire {
  status: string;
  url: string | null;
}

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
  // portalHint: the server mints no Stripe portal session on this wire —
  // the console Billing page (a real, env-correct link) is the door for
  // invoices, cards and cancellations.
  console.log(`  Manage invoices & payment methods: ${data.consoleBillingUrl}`);
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
