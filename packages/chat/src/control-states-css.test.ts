/**
 * Two web controls meet the pointer and the finger: Retry on a failed send
 * answers hover and press (dimming to 0.92 and 0.85, the native chip's press,
 * with the fade only for viewers who allow motion), and the attachment's
 * remove mark keeps its 24px look over a 44px hit area. Read from the shipped
 * stylesheet, located by selector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list includes exactly `selector`, at the top level of `css`. */
function blocksFor(css: string, selector: string): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) blocks.push(m[2] ?? "");
  }
  return blocks;
}

function declaration(block: string, property: string): string {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(block)?.[1]?.trim() ?? "";
}

/** The bodies of every `@media (prefers-reduced-motion: no-preference)` block. */
function motionAllowed(): string {
  const out: string[] = [];
  const re = /@media \(prefers-reduced-motion: no-preference\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) out.push(m[1] ?? "");
  return out.join("\n");
}

describe("web Retry answers hover and press", () => {
  it("dims to 0.92 on hover and 0.85 while pressed", () => {
    expect(declaration(blocksFor(raw, ".guuey-chat-retry:hover")[0] ?? "", "opacity")).toBe("0.92");
    expect(declaration(blocksFor(raw, ".guuey-chat-retry:active")[0] ?? "", "opacity")).toBe("0.85");
  });

  it("fades only for viewers who allow motion", () => {
    const allowed = blocksFor(motionAllowed(), ".guuey-chat-retry");
    expect(allowed.map((b) => declaration(b, "transition"))).toContain("opacity 120ms ease-out");
    for (const block of blocksFor(raw.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, ""), ".guuey-chat-retry")) {
      expect(declaration(block, "transition")).toBe("");
    }
  });
});

describe("the attachment's remove mark", () => {
  it("keeps its 24px mark", () => {
    const block = blocksFor(raw, ".guuey-chat-attachment-remove")[0] ?? "";
    expect(declaration(block, "width")).toBe("24px");
    expect(declaration(block, "height")).toBe("24px");
    expect(declaration(block, "position")).toBe("absolute");
  });

  it("has a 44px hit area: a pseudo-element 10px past each edge", () => {
    const block = blocksFor(raw, ".guuey-chat-attachment-remove::before")[0] ?? "";
    expect(declaration(block, "content")).toBe('""');
    expect(declaration(block, "position")).toBe("absolute");
    expect(declaration(block, "inset")).toBe("-10px");
  });
});
