/**
 * guuey#2302 — the card for an ask nothing in the chat can answer has its own
 * rules: a quiet ground and NO accent frame (it must not read as a prompt whose
 * buttons were cut off), and a hint in ink-muted 2px smaller with no margin.
 * Read from the shipped stylesheet, located by selector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if ((m[1] ?? "").split(",").some((s) => s.trim() === selector)) return m[2] ?? "";
  }
  return "";
}

describe("the no-answer-channel card (guuey#2302)", () => {
  it("has its own rule: a quiet ink ground, no border, no accent", () => {
    const b = block(".guuey-chat-prompt-info");
    expect(b).toMatch(/background:\s*color-mix\(in srgb, var\(--guuey-chat-ink[^)]*\)\) 5%, transparent\)/);
    expect(b).not.toMatch(/border:/);
    expect(b).not.toMatch(/--guuey-chat-accent/);
  });

  it("the hint is ink-muted, 2px smaller, margin 0", () => {
    const b = block(".guuey-chat-prompt-info-hint");
    expect(b).toMatch(/color:\s*var\(--guuey-chat-ink-muted/);
    expect(b).toMatch(/font-size:\s*calc\(1em - 2px\)/);
    expect(b).toMatch(/margin:\s*0/);
  });

  it("the choices list has its own rule", () => {
    expect(block(".guuey-chat-prompt-info-choices")).not.toBe("");
  });
});
