/**
 * guuey#2382 — the A2UI surface's look rules from spec §5.3, read from the
 * shipped stylesheet and located by selector: an image is full width under
 * a 220px cap and contained; a choice row and every field are a 36px target;
 * a choice's mark is the only colour (the link token) and its label is
 * weight 600 when chosen, 400 otherwise; each gap word maps to a step of the
 * theme's own gap. The token channels themselves are linted by
 * `theme-css.test.ts`, the shared focus ring by `focus-ring-css.test.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A2UI_GAP_TOKENS } from "./a2ui/schema.js";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every top-level rule whose selector list includes exactly `selector`. */
function declarations(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if ((m[1] ?? "").split(",").map((s) => s.trim()).includes(selector)) out.push(m[2] ?? "");
  }
  return out.join(";");
}

function value(selector: string, property: string): string {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(declarations(selector))?.[1]?.trim() ?? "";
}

describe("the A2UI surface's look (spec §5.3)", () => {
  it("an image is full width, capped at 220px, contained", () => {
    expect(value(".guuey-chat-a2ui-image", "width")).toBe("100%");
    expect(value(".guuey-chat-a2ui-image", "max-height")).toBe("220px");
    expect(value(".guuey-chat-a2ui-image", "object-fit")).toBe("contain");
  });

  it("a choice row, a checkbox row, a field, the picker and a button are 36px targets", () => {
    for (const selector of [".guuey-chat-a2ui-option", ".guuey-chat-a2ui-check", ".guuey-chat-a2ui-input", ".guuey-chat-a2ui-picker", ".guuey-chat-a2ui-button"]) {
      expect(value(selector, "min-height"), selector).toBe("36px");
    }
  });

  it("the mark is the only colour, the link token; the label is 600 chosen and 400 otherwise, never tinted", () => {
    expect(value(".guuey-chat-a2ui-option input", "accent-color")).toBe("var(--guuey-chat-link, var(--_guuey-chat-link, currentColor))");
    expect(value(".guuey-chat-a2ui-option", "font-weight")).toBe("400");
    expect(value(".guuey-chat-a2ui-option-selected", "font-weight")).toBe("600");
    expect(value(".guuey-chat-a2ui-option", "color")).toBe("");
    expect(value(".guuey-chat-a2ui-option-selected", "color")).toBe("");
  });

  it("every gap word has a rule, each a step of the theme's gap", () => {
    for (const gap of A2UI_GAP_TOKENS) {
      const v = value(`.guuey-chat-a2ui-gap-${gap}`, "gap");
      expect(v, gap).not.toBe("");
      if (gap !== "none") expect(v, gap).toContain("var(--guuey-chat-gap, var(--_guuey-chat-gap))");
    }
  });

  it("agent text sits in a bidi isolate", () => {
    for (const selector of [".guuey-chat-a2ui", ".guuey-chat-a2ui-text", ".guuey-chat-a2ui-label", ".guuey-chat-a2ui-superseded"]) {
      expect(value(selector, "unicode-bidi"), selector).toBe("isolate");
    }
  });
});
