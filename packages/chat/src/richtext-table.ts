/**
 * Table rendering support (guuey#370 — sdk#23's vocabulary, live since
 * `@silverprotocol/richtext@0.5.3`).
 *
 * The block type DERIVES from the upstream union (strict-typing rule:
 * the parser's types are the source of truth). History note: this module
 * was born one cut earlier as a structural MIRROR + narrowing guard so
 * both renderer arms could land BEFORE the bump (the renderers switch
 * default-less on `block.type` — a bump without an arm would have
 * rendered tables as NOTHING); with 0.5.3 pinned, the mirror and guard
 * are deleted per the pre-launch one-contract rule and the arms moved
 * into the switches proper.
 */
import type { RichTextBlock, RichTextTableCell } from "@silverprotocol/richtext";

export type RichTextTableBlock = Extract<RichTextBlock, { type: "table" }>;

/**
 * Renderer-side GFM normalization (defense in depth — the parser already
 * pads/drops): every row exactly `columnCount` cells, short rows padded
 * with empty-inline cells, excess dropped.
 */
export function normalizeTableRow(
  row: { cells: RichTextTableCell[] },
  columnCount: number,
): RichTextTableCell[] {
  const cells = row.cells.slice(0, columnCount);
  while (cells.length < columnCount) cells.push({ children: [] });
  return cells;
}
