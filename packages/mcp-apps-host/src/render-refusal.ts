/**
 * The typed read of a ggui_render PRE-GENERATION REFUSAL (guuey#836 —
 * `@ggui-ai/protocol` 0.14.0, PROTOCOL_VERSION `draft-2026-09-04`).
 *
 * A render result now carries a REQUIRED `outcome` discriminant:
 * `'rendered' | 'failed' | 'refused'`. The third arm is new — a deployment
 * that declined the render BEFORE doing any work (a missing app policy, an
 * exhausted trial, a deprovisioned app, …). Nothing was parsed, no session
 * row was committed and the handshake is intact, so every identity field
 * (`sessionId`, `resourceUri`, `cache`, …) is ABSENT and a `refusal`
 * envelope carries the state: a registry `code`, a `message` (what was
 * checked, against what), a `fix` addressed to the party that can take it,
 * and a `retry` class.
 *
 * Before this read existed a refusal reached a host as an `isError` tool
 * result with no locator — the mount dispatcher returned `undefined` and the
 * transcript showed the raw envelope text as a generic tool failure. That is
 * the "unexplained render failure" a builder cannot act on. This function
 * names the state instead, so a host can face the refusal with its own
 * words (the message, the fix, the retry hint) and never attempt a mount.
 *
 * Two properties are load-bearing and pinned by the tests:
 *  - It is TOLERANT of the previous wire: a result from a
 *    `draft-2026-08-*` server (no `outcome`, identity fields present) does
 *    not parse as a 0.14.0 output and yields `undefined` — exactly the
 *    behaviour such a result had before, never a false refusal.
 *  - It is STRICT about the envelope: the guard is the protocol's own
 *    `isRefusedRenderOutput` over `renderOutputSchema`'s parse, so a payload
 *    that merely SAYS `outcome: 'refused'` without a conformant `refusal`
 *    (an unregistered code, a missing `fix`) is not a refusal here either —
 *    the transport would have rejected it on the producing side, and a
 *    reader that half-trusted it would draw an authoritative-looking face
 *    over a non-conformant payload.
 *
 * The routing question (`uiData` vs `structuredContent`) does not arise: a
 * refusal has no `_meta.ui` sibling by construction (there is no surface
 * data), so it always lands in `structuredContent` (AgJSON §2.1).
 */
import {
  isRefusedRenderOutput,
  renderOutputSchema,
  type PreGenerationRefusal,
} from "@ggui-ai/protocol";
import type { JsonValue } from "@silverprotocol/core";

export type { PreGenerationRefusal };

/**
 * The refusal a `tool-result` block carries, or `undefined` when the block is
 * not a conformant 0.14.0 render output with `outcome: 'refused'`.
 */
export function toolResultRenderRefusal(block: {
  structuredContent?: JsonValue;
}): PreGenerationRefusal | undefined {
  if (block.structuredContent === undefined) return undefined;
  const parsed = renderOutputSchema.safeParse(block.structuredContent);
  if (!parsed.success) return undefined;
  return isRefusedRenderOutput(parsed.data) ? parsed.data.refusal : undefined;
}
