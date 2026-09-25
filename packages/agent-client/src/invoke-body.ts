/**
 * The invoke body — the ONE shape `useAgentInvoke` puts on the wire for a
 * turn, built here as a pure function so the shape has a name, a test and a
 * fixture (guuey#1213, the rolling-release rule).
 *
 * Why this is a module and not four lines inside the hook: the pod on the
 * other side of this wire rolls independently of the widget, and the founder's
 * 2026-09-10 ruling makes N−1 tolerance a CI check rather than a review
 * question. The canonical bodies this builder produces — from the cases in
 * `fixtures/widget-invoke-body-cases.ts`, into `fixtures/widget-invoke-bodies.json`,
 * pinned by `invoke-body.test.ts` — are
 * what the pod's `rolling-release.test.ts` runs through the PREVIOUS release's
 * frozen validator; at each release tag they become the previous release's
 * bodies the CURRENT validator must still accept. A field added here without
 * updating that fixture fails the pin; a field the pod starts requiring that
 * these bodies do not carry fails the pod's test. Both directions, mechanical.
 *
 * Every key is carried VERBATIM — all trust and semantics live pod-side (see
 * the option docblocks in `./types`). Optional keys are OMITTED when absent
 * (never `undefined`-valued), so the JSON on the wire has exactly the keys the
 * fixture shows.
 *
 * The cases live in `fixtures/`, never here: this module ships in every
 * consumer's bundle and in the npm package, and `src/fixtures/**` ships in
 * neither (excluded from the build and the pack). A test corpus in a runtime
 * module is carried into every bundle that imports the builder.
 */
import type { AgClientCapabilities } from "@silverprotocol/core";
import type { PageContext } from "./types.js";

export interface InvokeBodyInput {
  /** The user's text for this turn (non-empty; the pod refuses an empty one). */
  input: string;
  /** The durable conversation id, once the pod has minted one (absent on first contact). */
  threadId?: string | null;
  /** Idempotency key for this turn's user message. */
  clientMessageId: string;
  /** The advertised AgJSON client capabilities (spec §3), when any. */
  capabilities?: AgClientCapabilities;
  /** Where the visitor is on the embedding page (guuey#524 / #1105 hostOrigin-only). */
  pageContext?: PageContext;
  /** The client-named agent-mode pin (guuey#566) — carriage only. */
  mode?: string;
}

/** The wire body, exactly as sent. */
export interface InvokeBody {
  input: string;
  threadId?: string;
  clientMessageId: string;
  capabilities?: AgClientCapabilities;
  pageContext?: PageContext;
  mode?: string;
}

export function buildInvokeBody(i: InvokeBodyInput): InvokeBody {
  return {
    input: i.input,
    ...(i.threadId ? { threadId: i.threadId } : {}),
    clientMessageId: i.clientMessageId,
    ...(i.capabilities !== undefined ? { capabilities: i.capabilities } : {}),
    // guuey#524: the page-aware turn's carriage — read at send time by the
    // hook (SPA route changes ride the NEXT turn). All trust semantics are
    // pod-side; see the option's docblock.
    ...(i.pageContext !== undefined ? { pageContext: i.pageContext } : {}),
    // guuey#566: the client-named agent mode — carriage only; every semantic
    // (validation, fallback, subset) is pod-side.
    ...(i.mode !== undefined ? { mode: i.mode } : {}),
  };
}
