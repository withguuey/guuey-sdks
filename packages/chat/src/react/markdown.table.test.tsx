// @vitest-environment jsdom
/**
 * The table arm (guuey#370), driven DIRECTLY: the 0.5.2 parser cannot emit
 * a table block, so these pins exercise the exported arm with
 * contract-shaped fixtures — the exact shape the bumped parser will emit
 * (sdk#23's relayed contract). At bump time the full-pipeline pin joins
 * (parseRichText("|a|b|…") → <table>); these stay as the arm's own truth.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TableBlock } from "./markdown.js";
import { isRichTextTable, normalizeTableRow } from "../richtext-table.js";
import type { RichTextTableBlockMirror } from "../richtext-table.js";

afterEach(cleanup);

const FIXTURE: RichTextTableBlockMirror = {
  type: "table",
  align: ["left", "center", undefined],
  header: {
    cells: [
      { children: [{ type: "text", text: "Name" }] },
      { children: [{ type: "text", text: "Qty" }] },
      { children: [{ type: "text", text: "Note" }] },
    ],
  },
  rows: [
    {
      cells: [
        { children: [{ type: "text", text: "Widget" }] },
        { children: [{ type: "text", text: "2" }] },
        { children: [{ type: "text", text: "<script>alert(1)</script>" }] },
      ],
    },
    // Short row: pads to 3 (GFM).
    { cells: [{ children: [{ type: "text", text: "Gadget" }] }] },
  ],
};

describe("guuey#370 — the react table arm", () => {
  it("renders thead/tbody with per-column alignment; cells ride the sanitizer path", () => {
    const { container } = render(<TableBlock block={FIXTURE} />);
    expect(container.querySelector("table.guuey-chat-table")).toBeTruthy();
    const ths = [...container.querySelectorAll("th")];
    expect(ths).toHaveLength(3);
    expect(ths[0]!.style.textAlign).toBe("left");
    expect(ths[1]!.style.textAlign).toBe("center");
    expect(ths[2]!.style.textAlign).toBe(""); // undefined align = no inline style
    // The sanitizer boundary: raw HTML in a cell is LITERAL TEXT, no elements.
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
  });

  it("short rows pad to the header's column count; excess drops", () => {
    const { container } = render(<TableBlock block={FIXTURE} />);
    const secondRowCells = container.querySelectorAll("tbody tr:nth-child(2) td");
    expect(secondRowCells).toHaveLength(3); // padded
    expect(
      normalizeTableRow({ cells: [...FIXTURE.header.cells, { children: [] }] }, 3),
    ).toHaveLength(3); // excess dropped
  });

  it("the guard admits the contract shape and refuses half-shaped blocks", () => {
    expect(isRichTextTable(FIXTURE)).toBe(true);
    expect(isRichTextTable({ type: "paragraph" })).toBe(false);
    expect(isRichTextTable({ type: "table", align: [], header: {}, rows: [] })).toBe(false);
  });
});
