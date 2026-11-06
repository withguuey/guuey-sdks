/**
 * A user send that did not go, on the web tier: the failed bubble is the
 * reader's own words, so it is calm in both tones, hollow (surface fill, a 1px
 * muted-ink border, ink words, full opacity). The tone lives on the line under
 * it: a fault keeps the error colour, the retry tone draws muted ink. Retry is
 * the accent in both tones. Read from the shipped stylesheet, located by
 * selector.
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

function declaration(block: string, property: string): string {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(block)?.[1]?.trim() ?? "";
}

const ERROR = /--guuey-chat-error/;

describe("the failed send (web)", () => {
  it("draws the failed bubble hollow: surface fill, 1px muted-ink border, ink words, full opacity", () => {
    const blocks = blocksFor(".guuey-chat-user-failed .guuey-chat-user-bubble");
    expect(blocks).toHaveLength(1);
    const block = blocks[0] ?? "";
    expect(declaration(block, "background")).toMatch(/^var\(--guuey-chat-surface,/);
    expect(declaration(block, "color")).toMatch(/^var\(--guuey-chat-ink,/);
    expect(declaration(block, "border")).toMatch(/^1px solid var\(--guuey-chat-ink-muted,/);
    expect(declaration(block, "opacity")).toBe("1");
    expect(block).not.toMatch(ERROR);
  });

  it("puts the tone on the line: a fault in the error colour, the retry tone in muted ink", () => {
    const fault = blocksFor(".guuey-chat-send-failed");
    expect(fault.length).toBeGreaterThan(0);
    expect(declaration(fault[0] ?? "", "color")).toMatch(/^var\(--guuey-chat-error,/);
    const retry = blocksFor(".guuey-chat-send-failed-retry");
    expect(retry).toHaveLength(1);
    expect(declaration(retry[0] ?? "", "color")).toMatch(/^var\(--guuey-chat-ink-muted,/);
  });

  it("draws Retry in the theme's chip face in both tones (the stamped chip tokens, through the host channel)", () => {
    const block = blocksFor(".guuey-chat-retry")[0] ?? "";
    expect(declaration(block, "background")).toBe("var(--guuey-chat-chip-fill, var(--_guuey-chat-chip-fill))");
    expect(declaration(block, "color")).toBe("var(--guuey-chat-chip-ink, var(--_guuey-chat-chip-ink))");
    expect(declaration(block, "border")).toBe("1px solid var(--guuey-chat-chip-edge, var(--_guuey-chat-chip-edge))");
    expect(declaration(block, "border-radius")).toBe("6px");
    expect(block).not.toMatch(ERROR);
  });

  it("dims only the sending bubble", () => {
    expect(declaration(blocksFor(".guuey-chat-user-sending .guuey-chat-user-bubble")[0] ?? "", "opacity")).toBe("0.6");
  });
});
