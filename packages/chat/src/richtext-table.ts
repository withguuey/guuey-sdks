/**
 * The richtext TABLE contract (silverprotocol sdk#23 — guuey#370's
 * unlock), as a STRUCTURAL MIRROR, pre-bump.
 *
 * `@silverprotocol/richtext@0.5.2` has no table node; the next cut adds
 * one with exactly this shape (contract relayed verbatim from the sdk#23
 * implementation ahead of its publish). Both kit renderers switch on
 * `block.type` with NO default arm returning content, so a richtext bump
 * WITHOUT a table arm would render tables as NOTHING — strictly worse
 * than today's literal pipe-text. These mirrors let both arms land
 * BEFORE the bump (dead code until the parser emits the member: the
 * guard below can never match a 0.5.2 block), and at bump time the
 * mirrors swap for the upstream exports (`RichTextTableAlign`,
 * `RichTextTableCell`, `RichTextTableRow`) in an import-line-only diff —
 * the strict-typing rule's derive-from-source, staged in two moves
 * because the source isn't published yet.
 *
 * Contract notes carried with the shape: cells are INLINE-ONLY (the same
 * parser and safety policy as every other inline run — raw HTML stays
 * literal text, SAFE_HREF gates links); `align` is per-column with
 * `length === column count`; no `closed` flag (like lists); streaming
 * forms a table only after a complete delimiter line (one-way flip from
 * a two-line paragraph); short rows pad and excess cells drop (GFM) —
 * the parser normalizes, and the renderers ALSO normalize defensively.
 */
import type { RichTextInline } from "@silverprotocol/richtext";

export type RichTextTableAlignMirror = "left" | "center" | "right" | undefined;

export interface RichTextTableCellMirror {
  children: RichTextInline[];
}

export interface RichTextTableRowMirror {
  cells: RichTextTableCellMirror[];
}

export interface RichTextTableBlockMirror {
  type: "table";
  /** Per column; length = column count. */
  align: RichTextTableAlignMirror[];
  header: RichTextTableRowMirror;
  rows: RichTextTableRowMirror[];
}

/**
 * The pre-bump narrowing door: a type predicate over a structurally
 * WIDER parameter, so it compiles against the 0.5.2 union (which lacks
 * the member) and starts matching the moment the bumped parser emits
 * `type: "table"` blocks. Runtime shape-checks guard the cross-version
 * boundary honestly — a half-shaped block renders nothing rather than
 * throwing mid-transcript.
 */
export function isRichTextTable(block: {
  type: string;
  // Cross-version boundary fields: genuinely untyped until the bumped
  // parser's types land — validated below, never asserted.
  align?: unknown;
  header?: unknown;
  rows?: unknown;
}): block is RichTextTableBlockMirror {
  if (block.type !== "table") return false;
  const rowShaped = (r: unknown): r is RichTextTableRowMirror => {
    if (typeof r !== "object" || r === null || !("cells" in r)) return false;
    return Array.isArray(r.cells);
  };
  return (
    Array.isArray(block.align) &&
    rowShaped(block.header) &&
    Array.isArray(block.rows) &&
    block.rows.every(rowShaped)
  );
}

/**
 * Renderer-side GFM normalization (defense in depth — the parser already
 * pads/drops): every row exactly `columnCount` cells, short rows padded
 * with empty-inline cells, excess dropped.
 */
export function normalizeTableRow(
  row: RichTextTableRowMirror,
  columnCount: number,
): RichTextTableCellMirror[] {
  const cells = row.cells.slice(0, columnCount);
  while (cells.length < columnCount) cells.push({ children: [] });
  return cells;
}
