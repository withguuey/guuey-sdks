/**
 * guuey#2303 — the chat header's close button is a fixed 32x32 target (WCAG 2.5.8
 * asks 24x24; the widget's own toggle is 32x32), and its negative margin keeps the
 * header row's height and right inset as they were. Read from the shipped
 * stylesheet, located by selector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block whose selector list includes exactly `selector`. */
function block(selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if ((m[1] ?? "").split(",").some((s) => s.trim() === selector)) return m[2] ?? "";
  }
  return "";
}

describe("the chat header's close button (guuey#2303)", () => {
  it("is a fixed 32x32 box, centred, with a margin that keeps the row's height and inset", () => {
    const b = block(".guuey-chat-header-close");
    expect(b).toMatch(/width:\s*32px/);
    expect(b).toMatch(/height:\s*32px/);
    expect(b).toMatch(/display:\s*inline-grid/);
    expect(b).toMatch(/place-items:\s*center/);
    expect(b).toMatch(/margin:\s*-6px -8px -6px 0/);
    expect(b).toMatch(/padding:\s*0/);
  });

  it("hover lays a 6% ink disc behind the glyph, as the widget's toggle does; focus keeps its ring", () => {
    expect(block(".guuey-chat-header-close:hover")).toMatch(/background:\s*color-mix\(in srgb, var\(--guuey-chat-ink[^)]*\)\) 6%, transparent\)/);
    expect(block(".guuey-chat-header-close:focus-visible")).toMatch(/outline:\s*2px solid/);
  });
});
