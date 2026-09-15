/**
 * The view host's own user-facing copy — the i18n seam for the default
 * status line (guuey#1279 Track A, extended on guuey#1325).
 *
 * ## Why this file exists
 *
 * `GuueyView`'s default status used to hardcode its English copy inline, and
 * that copy narrated the PROTOCOL: "Negotiating with view…" is the
 * {@link ViewHostPhase} member `"negotiating"` shown to a person, and the
 * boot-failure line said the view "never negotiated with the host". guuey#1279
 * rules that lifecycle vocabulary is machinery and must not reach chrome; the
 * rule was enforced in `@guuey/chat` but this package renders its own chrome,
 * so the same defect survived here and shipped — a large blank frame captioned
 * with a protocol noun on a public page (guuey#1325).
 *
 * Two things were wrong, and they are separable:
 *
 *  1. **The words.** Fixed by using product copy, deliberately IDENTICAL to
 *     `@guuey/chat`'s `viewNegotiating` / `viewBootFailure` so the two packages
 *     speak with one voice on the same states. They cannot share a constant:
 *     `@guuey/chat` depends on this package, so an import the other way is a
 *     cycle. The duplication is intentional and pinned by a test.
 *
 *  2. **The seam.** Hardcoded literals are unreachable by translation. A host
 *     that localised every string it could still got English here, and
 *     `renderStatus` — the only existing escape — forces a host to reimplement
 *     the CSP/channel branching just to change a word. These strings are
 *     overridable on their own.
 */

/** The default status line's copy. Every user-facing word this package renders. */
export interface ViewHostStrings {
  /**
   * While the view is loading — the `"negotiating"` phase. Says what the
   * PERSON is waiting for (a view), never what the protocol is doing.
   */
  viewLoading: string;
  /**
   * A ggui shell that never started — the `"no-handshake"` phase on the
   * `"ggui"` channel, where silence is a boot failure with no other author.
   * A CSP diagnosis outranks this (it names the actual blocked URI).
   */
  viewBootFailure: string;
}

/**
 * en defaults. Kept byte-identical to `@guuey/chat`'s `viewNegotiating` and
 * `viewBootFailure` — `view-chrome-vocabulary.test.ts` pins both the wording
 * and the absence of protocol vocabulary.
 */
export const defaultViewHostStrings: ViewHostStrings = {
  viewLoading: "Loading view…",
  viewBootFailure: "This view couldn't start",
};
