/**
 * The invoke body — the ONE shape `useAgentInvoke` puts on the wire for a
 * turn, built here as a pure function so the shape has a name, a test and a
 * fixture (guuey#1213, the rolling-release rule).
 *
 * Why this is a module and not four lines inside the hook: the pod on the
 * other side of this wire rolls independently of the widget, and the founder's
 * 2026-09-10 ruling makes N−1 tolerance a CI check rather than a review
 * question. The canonical bodies this builder produces
 * (`fixtures/widget-invoke-bodies.json`, pinned by `invoke-body.test.ts`) are
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

/**
 * The canonical bodies the guuey WIDGET sends (`apps/widget` composes them
 * through `useAgentInvoke` with `preserveBlocks: true`, so the default
 * capabilities ride; a `guuey("page", …)` call adds the page block, and the
 * INIT origin stands in before any page call — guuey#1105). This list IS the
 * fixture: `invoke-body.test.ts` pins `fixtures/widget-invoke-bodies.json` to
 * it byte-for-byte, and the pod's rolling-release test consumes that file.
 * Add a case here when the widget starts sending a new shape.
 */
export const WIDGET_INVOKE_BODY_CASES: ReadonlyArray<{ name: string; why: string; input: InvokeBodyInput }> = [
  {
    name: "session-open-init-origin",
    why: "first contact: no threadId; the INIT origin stands in as a hostOrigin-only block (guuey#1105); default block-preserving capabilities",
    input: {
      input: "Hello",
      clientMessageId: "cm_0001",
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: { hostOrigin: "https://customer.example" },
    },
  },
  {
    name: "turn-with-page",
    why: "a later turn after a guuey(\"page\", …) call: threadId replayed, full page block with context",
    input: {
      input: "What does this page say about pricing?",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_0002",
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: {
        path: "/pricing",
        title: "Pricing — Acme",
        context: "Plans: Starter, Pro, Scale.",
        hostOrigin: "https://customer.example",
      },
    },
  },
  {
    name: "turn-with-page-no-context",
    why: "a page call without a host-declared context line (the common case)",
    input: {
      input: "Book a demo",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_0003",
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: { path: "/", title: "Acme", hostOrigin: "https://customer.example" },
    },
  },
  {
    name: "guest-mode-pin",
    why: "the embed pinned agent mode 'guest' (guuey#566) — carried verbatim",
    input: {
      input: "Hi",
      clientMessageId: "cm_0004",
      capabilities: { hitl: { ask: true, grantModes: true } },
      pageContext: { hostOrigin: "https://customer.example" },
      mode: "guest",
    },
  },
  {
    name: "sdk-minimal",
    why: "an SDK consumer with preserveBlocks off and no page: input + clientMessageId only",
    input: { input: "ping", clientMessageId: "cm_0005" },
  },
];
