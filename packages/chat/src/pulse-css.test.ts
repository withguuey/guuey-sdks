/**
 * The kit's pulse breathes text colour, never opacity: a mute is a colour.
 * Every pulsed element is text, and the trough is an opaque mix of the ink
 * and the muted ink (its contrast is pinned in theme.contrast.test.ts), so a
 * pulsing line never dips under the muted ink's contrast. Read from the
 * shipped stylesheet and the renderer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const renderer = readFileSync(fileURLToPath(new URL("./react/components.tsx", import.meta.url)), "utf8");

function keyframes(name: string): string {
  const start = raw.indexOf(`@keyframes ${name}`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  let depth = 0;
  for (let i = raw.indexOf("{", start); i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    if (raw[i] === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  throw new Error("unbalanced");
}

describe("the pulse is a colour breath, never an opacity fade", () => {
  it("animates color to the opaque ink / muted-ink midpoint and nothing else", () => {
    const body = keyframes("guuey-chat-pulse");
    expect(body).not.toMatch(/opacity/);
    expect(body.replace(/\s+/g, " ")).toMatch(
      /color: color-mix\( in srgb, var\(--guuey-chat-ink, var\(--_guuey-chat-ink\)\) 50%, var\(--guuey-chat-ink-muted, var\(--_guuey-chat-ink-muted\)\) \)/,
    );
  });

  it("the negotiating view pulses its words, not the box around them (the words carry their own colour)", () => {
    expect(renderer).toMatch(/<p className="guuey-chat-shimmer" role="status">/);
    expect(renderer).not.toMatch(/guuey-chat-view-negotiating guuey-chat-shimmer/);
  });
});
