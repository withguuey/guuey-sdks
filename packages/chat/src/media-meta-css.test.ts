/**
 * Two layout rules of the shipped stylesheet, located by selector:
 * - an image and a media chip hug their content in the item's column (a flex
 *   item stretches by default), and a long chip label wraps inside the chip;
 * - in a data result's meta row, "Show all" and Copy are one kind of action:
 *   the row's size, one decoration, no padding of their own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list includes exactly `selector`. */
function blocksFor(selector: string): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) blocks.push(m[2] ?? "");
  }
  return blocks;
}

/** The last value `property` takes across `selector`'s blocks, in sheet order. */
function value(selector: string, property: string): string {
  let found = "";
  for (const block of blocksFor(selector)) {
    const m = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(block);
    if (m?.[1] !== undefined) found = m[1].trim();
  }
  return found;
}

describe("media in the transcript column", () => {
  for (const selector of [".guuey-chat-media-image", ".guuey-chat-media-chip"]) {
    it(`${selector} hugs its content and never exceeds the column`, () => {
      expect(value(selector, "align-self")).toBe("flex-start");
      expect(value(selector, "max-width")).toBe("100%");
    });
  }

  it("a long chip label wraps inside the chip", () => {
    expect(value(".guuey-chat-media-chip", "overflow-wrap")).toBe("anywhere");
  });
});

describe("the data meta row's actions", () => {
  const MORE = ".guuey-chat-data-meta .guuey-chat-data-more";
  const COPY = ".guuey-chat-data-meta .guuey-chat-copy";

  it("share one rule", () => {
    const shared = blocksFor(MORE).filter((b) => blocksFor(COPY).includes(b));
    expect(shared).toHaveLength(1);
  });

  it("take the row's size, one decoration and no padding of their own", () => {
    for (const selector of [MORE, COPY]) {
      expect(value(selector, "font-size")).toBe("inherit");
      expect(value(selector, "text-decoration")).toBe("underline");
      expect(value(selector, "padding")).toBe("0");
    }
  });

  it("leave Copy elsewhere at its own size", () => {
    expect(value(".guuey-chat-copy", "font-size")).toBe("0.9em");
  });
});
