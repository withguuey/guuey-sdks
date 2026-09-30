/**
 * The tap-label contract (guuey#2031): the words a visitor's card tap shows as
 * their turn, carried beside the card-action turn they stand for.
 *
 * A card tap reaches the conversation as ggui's user-action doorbell, a
 * directive written for the model. The transcript draws that turn as what was
 * tapped, never as the directive and never as typed speech. The words come from
 * the host (the tapped chip's label, read from the props the host already
 * holds), ride the send as one optional per-tap list, are stored beside the user
 * row, and are read back by the history plane, so the turn reads the same after
 * a reload.
 *
 * One home, one shape, three contracts:
 *
 *  - {@link tapText} is the PRODUCER normalizer: a label is quoted verbatim or
 *    not at all. It never truncates, because a truncated quote is a paraphrase.
 *  - {@link writeTapLabels} is the WRITER contract (the client before it sends,
 *    the runtime before it stores): bounded, all or nothing, never a throw.
 *  - {@link readTapLabels} is the READER contract (read planes, the history
 *    mapper, the planner): SHAPE ONLY. The bounds belong to the writer, so a
 *    later writer may loosen them without an older reader dropping stored rows.
 *
 * Display-only by construction: the directive stays the turn's text and the
 * model's input; nothing here reaches a model path.
 *
 * Protocol-free on purpose: this module rides the `./narrowing` subpath, which
 * `@guuey/threads` re-exports, so the persistence side never pulls
 * `@ggui-ai/protocol` into its runtime graph.
 */

/**
 * One entry per card tap that a card-action user row stands for, in tap order:
 * the tapped control's visible words, or `null` when that tap had none (its
 * position then shows the continuation copy).
 *
 * A list, not a scalar: two taps on one card while a turn is live produce the
 * same directive text, and the send gate merges identical texts into one send,
 * so one stored row can stand for several taps.
 */
export type TapLabels = readonly (string | null)[];

/** The most taps one row may carry (writer bound). */
export const MAX_TAP_LABELS = 8;

/** The longest one label may be, in UTF-16 code units (writer bound). */
export const MAX_TAP_LABEL_UNITS = 200;

/**
 * The most the whole list may weigh, in UTF-8 bytes of its JSON encoding
 * (writer bound). The stored row's size counts against the history window the
 * runtime reads back per turn, so the list is capped as a whole on top of the
 * per-entry bound: eight maximal labels would otherwise weigh about 4.8 KB.
 */
export const MAX_TAP_LABELS_BYTES = 1024;

/**
 * A C0 or C1 control, or a bidi formatting character (ALM, LRM, RLM, the
 * embeddings and overrides, the isolates). Whitespace controls never reach this
 * test: {@link tapText} collapses them to one space first. Code points, never a
 * character class: the source then carries none of these characters itself.
 */
function isRefusedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function holdsRefusedCharacter(text: string): boolean {
  for (const ch of text) {
    if (isRefusedCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * The producer normalizer: whitespace runs become one space, and the result is
 * trimmed. `null` when the result is empty, longer than
 * {@link MAX_TAP_LABEL_UNITS} UTF-16 units, or holds a control or bidi
 * formatting character. Never truncates.
 */
export function tapText(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "" || text.length > MAX_TAP_LABEL_UNITS) return null;
  if (holdsRefusedCharacter(text)) return null;
  return text;
}

/** UTF-8 byte length of a string, counted by code point (no encoder needed on any runtime). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * The WRITER contract. An array of 1 to {@link MAX_TAP_LABELS} entries, each
 * `null` or a string that {@link tapText} leaves unchanged, at least one of them
 * a string, and at most {@link MAX_TAP_LABELS_BYTES} UTF-8 bytes as JSON. All
 * or nothing: any violation returns `undefined` (the row then carries no labels
 * and draws the continuation copy). Never throws. Returns a fresh copy.
 */
export function writeTapLabels(raw: unknown): TapLabels | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TAP_LABELS) return undefined;
  const labels: (string | null)[] = [];
  let anyText = false;
  for (const entry of raw) {
    if (entry === null) {
      labels.push(null);
      continue;
    }
    if (typeof entry !== "string" || tapText(entry) !== entry) return undefined;
    labels.push(entry);
    anyText = true;
  }
  if (!anyText) return undefined;
  if (utf8Bytes(JSON.stringify(labels)) > MAX_TAP_LABELS_BYTES) return undefined;
  return labels;
}

/**
 * The READER contract. SHAPE ONLY: an array whose entries are each `null` or a
 * non-empty string, at least one of them a string. No count or length bounds
 * (those are the writer's). `undefined` for anything else. Returns a fresh copy.
 */
export function readTapLabels(raw: unknown): TapLabels | undefined {
  if (!Array.isArray(raw)) return undefined;
  const labels: (string | null)[] = [];
  let anyText = false;
  for (const entry of raw) {
    if (entry === null) {
      labels.push(null);
      continue;
    }
    if (typeof entry !== "string" || entry === "") return undefined;
    labels.push(entry);
    anyText = true;
  }
  return anyText ? labels : undefined;
}

/**
 * The ONE test for a forwarded view-directive turn, shared by the planner (what
 * draws as an action turn) and the runtime (which rows may carry labels): the
 * `<ggui_directive` carrier ggui's doorbell writes into its message text. A
 * substring, deliberately not a parse: if ggui changes the directive's inner
 * shape, the live draw and the stored row must still agree.
 */
export function isViewDirectiveText(text: string): boolean {
  return text.includes("<ggui_directive");
}
