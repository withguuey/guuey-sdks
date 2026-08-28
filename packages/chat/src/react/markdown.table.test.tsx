// @vitest-environment jsdom
/**
 * The table arm (guuey#370, live since richtext 0.5.3): the arm's own
 * pins (alignment, sanitizer boundary, GFM pad/drop) plus the
 * FULL-PIPELINE pin — parseRichText over real GFM source → <table> —
 * which became possible the moment the bumped parser shipped.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Markdown, TableBlock } from "./markdown.js";
import { normalizeTableRow } from "../richtext-table.js";
import type { RichTextTableBlock } from "../richtext-table.js";

afterEach(cleanup);

const FIXTURE: RichTextTableBlock = {
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

  it("FULL PIPELINE: real GFM source parses and renders as a table — the bump landed into a ready arm", () => {
    const { container } = render(
      <Markdown text={"| Name | Qty |\n| :-- | :-: |\n| Widget | 2 |\n| Gadget | 5 |"} />,
    );
    const table = container.querySelector("table.guuey-chat-table");
    expect(table).toBeTruthy();
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByText("Widget")).toBeTruthy();
    // Per-column alignment from the delimiter row reaches the DOM.
    expect((container.querySelectorAll("tbody td")[1] as HTMLElement).style.textAlign).toBe(
      "center",
    );
  });
});
