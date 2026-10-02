/**
 * guuey#2121 — the "Jump to latest" chip. Its label colour must never be a
 * theme token a theme may set transparent (a transparent canvas made it a
 * label-less black pill on guuey.com), and it sits on the seam between the
 * transcript and what follows, never absolutely in the transcript's corner over
 * content. Read from the shipped stylesheet, located by selector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** Every declaration block whose selector list includes exactly `.guuey-chat-jump`. */
function jumpBlocks(): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.some((s) => /(^|\s)\.guuey-chat-jump$/.test(s))) blocks.push(m[2] ?? "");
  }
  return blocks;
}

describe("the jump chip (guuey#2121)", () => {
  it("is found in the stylesheet", () => {
    expect(jumpBlocks().length).toBeGreaterThan(0);
  });

  it("never paints its label in a theme token (canvas or surface)", () => {
    for (const block of jumpBlocks()) {
      const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(block)?.[1] ?? "";
      expect(color).not.toMatch(/--guuey-chat-canvas|--guuey-chat-surface/);
    }
  });

  it("sits on the seam, centred, never in the transcript's bottom-right corner", () => {
    const base = jumpBlocks()[0] ?? "";
    expect(base).toMatch(/left:\s*50%/);
    expect(base).toMatch(/bottom:\s*0/);
    expect(base).toMatch(/transform:\s*translate\(-50%,\s*50%\)/);
    expect(base).not.toMatch(/inset-inline-end/);
  });
});
