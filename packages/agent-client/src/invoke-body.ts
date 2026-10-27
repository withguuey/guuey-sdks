/**
 * The invoke body — the ONE shape `useAgentInvoke` puts on the wire for a
 * turn, built here as a pure function so the shape has a name, a test and a
 * fixture (guuey#1213, the rolling-release rule).
 *
 * Why this is a module and not four lines inside the hook: the pod on the
 * other side of this wire rolls independently of the widget, and the
 * rolling-release rule makes N−1 tolerance a CI check rather than a review
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
import type { TapLabels } from "@guuey/mcp-apps-host/narrowing";
import type { PageContext } from "./types.js";
import type { ImageAttachment } from "./attachments.js";
import type { InputKind } from "./input-kinds.js";

export interface InvokeBodyInput {
  /**
   * The user's text for this turn. Empty only beside {@link inputKind}: the
   * runtime refuses an empty input on its own.
   */
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
  /**
   * A card tap's own words beside its directive (guuey#2031), one entry per
   * tap. The caller passes a list that met the writer contract; the runtime
   * judges it again before it stores it, and an older runtime ignores the key.
   */
  tapLabels?: TapLabels;
  /**
   * The turn's images (guuey#2293), already judged by
   * `validateImageAttachments`. An empty list is the same as none: no key.
   */
  attachments?: readonly ImageAttachment[];
  /**
   * Where a turn without text has its content (guuey#2549): put on the wire
   * only beside an empty input, which is the runtime's own rule (beside text
   * the text is the turn).
   */
  inputKind?: InputKind;
}

/** The wire body, exactly as sent. */
export interface InvokeBody {
  input: string;
  threadId?: string;
  clientMessageId: string;
  capabilities?: AgClientCapabilities;
  pageContext?: PageContext;
  mode?: string;
  tapLabels?: TapLabels;
  attachments?: readonly ImageAttachment[];
  inputKind?: InputKind;
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
    // guuey#2031: a card tap's words — carriage only; the runtime judges them
    // again, and a runtime that predates them ignores the key.
    ...(i.tapLabels !== undefined ? { tapLabels: i.tapLabels } : {}),
    // guuey#2293: the turn's images, last. Every released runtime parses an
    // inline attachment and ignores it, so the hook proceeds only on the
    // runtime's acknowledgement (see `useAgentInvoke`).
    ...(i.attachments !== undefined && i.attachments.length > 0 ? { attachments: i.attachments } : {}),
    // guuey#2549: a turn without text, last. A runtime that predates input
    // kinds refuses an empty input before the stream; the hook reads that
    // refusal (see `isInputKindRefusal`).
    ...(i.inputKind !== undefined && i.input === "" ? { inputKind: i.inputKind } : {}),
  };
}
