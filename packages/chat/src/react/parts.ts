/**
 * The kit's `::part()` contract (guuey#1152, half i-a).
 *
 * When `<GuueyChat>` renders inside a shadow root — the widget loader's
 * `transcript: 'inline'` mount puts the transcript in the HOST page's own
 * DOM, behind a shadow boundary so the host's stylesheet cannot leak in and
 * the kit's cannot leak out — the host page can still restyle the kit's
 * STRUCTURAL elements, and only those, through CSS Shadow Parts:
 *
 *     .guuey-widget-transcript::part(message user) { … }
 *     .guuey-widget-transcript::part(header)       { display: none }
 *
 * The names below are that contract. Each is stamped as a `part` attribute
 * on exactly one structural element per role; `message` additionally
 * carries a second token naming the role (`part="message user"` on the
 * visitor's bubble, `part="message agent"` on the agent's text), so a host
 * can address all messages or one side. ADDITIVE ONLY: the class names stay
 * the styling surface for light-DOM consumers and the stylesheet is
 * byte-identical — `part` is a hook, never a selector this kit reads.
 *
 * The table is CLOSED and pinned (`parts.test.tsx`): add, never rename.
 */
export const PARTS = {
  /** `<GuueyChat>`'s outer surface — the element the theme is stamped on. */
  surface: "surface",
  /** The header slot's row (guuey#1150) — present only when `header` is given. */
  header: "header",
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
  /** The composer's textarea. */
  composerInput: "composer-input",
  /** The composer's Send button (idle). */
  composerSend: "composer-send",
  /** The composer's Stop button — replaces Send while a turn is in flight. */
  composerStop: "composer-stop",
  /** The suggestion-chips row (absent when there are no chips). */
  chips: "chips",
  /** One suggestion chip. */
  chip: "chip",
} as const;

/** The `part` value for one message role — `"message user"` / `"message agent"`. */
export function messagePart(role: "user" | "agent"): string {
  return `${PARTS.message} ${PARTS[role]}`;
}
