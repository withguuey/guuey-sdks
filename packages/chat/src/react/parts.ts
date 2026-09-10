/**
 * The kit's `::part()` contract (guuey#1152, half i-a).
 *
 * When `<GuueyChat>` renders inside a shadow root — the widget loader's
 * `transcript: 'inline'` mount puts the transcript in the HOST page's own
 * DOM, behind a shadow boundary so the host's stylesheet cannot leak in and
 * the kit's cannot leak out — the host page can still restyle the kit's
 * STRUCTURAL elements, and only those, through CSS Shadow Parts:
 *
 *     .guuey-widget-inline::part(message user) { … }
 *     .guuey-widget-inline::part(composer)     { display: none }
 *
 * The names below are that contract. Each is stamped as a `part` attribute
 * on exactly one structural element per role; `message` additionally
 * carries a second token naming the role (`part="message user"` on the
 * visitor's bubble, `part="message agent"` on the agent's text), so a host
 * can address all messages or one side. ADDITIVE ONLY: the class names stay
 * the styling surface for light-DOM consumers and the stylesheet is
 * byte-identical — `part` is a hook, never a selector this kit reads.
 *
 * `header` is deliberately absent: this kit has no header slot yet (the
 * header lands with guuey#1150); when it does, it takes the part name
 * `header` and joins this table — add, never rename.
 */
export const PARTS = {
  /** `<GuueyChat>`'s outer surface — the element the theme is stamped on. */
  surface: "surface",
  /** The transcript root (`<Transcript>`'s `.guuey-chat`). */
  transcript: "transcript",
  /** Every message; paired with `user` / `agent` as a second token. */
  message: "message",
  /** The visitor's bubble: `part="message user"`. */
  user: "user",
  /** The agent's text: `part="message agent"`. */
  agent: "agent",
  /** The built-in composer form (absent when `composer={false}`). */
  composer: "composer",
  /** The suggestion-chips row (absent when there are no chips). */
  chips: "chips",
} as const;

/** The `part` value for one message role — `"message user"` / `"message agent"`. */
export function messagePart(role: "user" | "agent"): string {
  return `${PARTS.message} ${PARTS[role]}`;
}
