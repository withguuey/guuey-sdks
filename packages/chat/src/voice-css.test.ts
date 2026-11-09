/**
 * guuey#2446 — the composer mic's two faces in the shipped stylesheet: the
 * live mic is the composer's one moving state, so its cue breathes (the
 * shimmer's colour breath, stopped under reduced motion), and a disabled
 * composer button is a colour, never an opacity, for the attach button and
 * the mic alike. Read from the stylesheet, located by selector and order.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const raw = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const PRESSED = '.guuey-chat-composer-voice[aria-pressed="true"]';
const REDUCE = "@media (prefers-reduced-motion: reduce)";

/** Every top-level [selectors, body, offset] rule, nested @media bodies included as their own rules. */
function rules(): Array<{ selectors: string[]; body: string; at: number }> {
  const out: Array<{ selectors: string[]; body: string; at: number }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const head = (m[1] ?? "").replace(/@media[^{]*\{/g, "");
    out.push({ selectors: head.split(",").map((s) => s.trim()), body: m[2] ?? "", at: m.index });
  }
  return out;
}

function declaration(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1]?.trim();
}

describe("the live mic's cue breathes, and reduced motion stops it", () => {
  const reduceAt = raw.indexOf(REDUCE);

  it("exactly one rule gives the pressed mic the pulse, and it sits BEFORE the reduced-motion list", () => {
    const pulsing = rules().filter((r) => r.selectors.includes(PRESSED) && /animation:\s*guuey-chat-pulse\b/.test(r.body));
    expect(pulsing).toHaveLength(1);
    expect(reduceAt).toBeGreaterThan(-1);
    expect(pulsing[0]?.at).toBeLessThan(reduceAt);
  });

  it("the reduced-motion list names the pressed mic, and no rule after that list sets its animation again", () => {
    const block = raw.slice(reduceAt, raw.indexOf("}", raw.indexOf("animation: none", reduceAt)) + 1);
    expect(block).toContain(PRESSED);
    const blockEnd = reduceAt + block.length;
    const later = rules().filter((r) => r.at > blockEnd && r.selectors.includes(PRESSED) && declaration(r.body, "animation") !== undefined);
    expect(later).toHaveLength(0);
  });
});

describe("a disabled composer button is a colour, never an opacity", () => {
  for (const button of [".guuey-chat-composer-attach", ".guuey-chat-composer-voice"]) {
    it(`${button}:disabled: a muted glyph on a transparent fill, with no opacity anywhere`, () => {
      const disabled = rules().filter((r) => r.selectors.includes(`${button}:disabled`));
      expect(disabled).toHaveLength(1);
      const body = disabled[0]?.body ?? "";
      expect(declaration(body, "color")).toBe("var(--guuey-chat-ink-muted, var(--_guuey-chat-ink-muted))");
      expect(declaration(body, "background")).toBe("transparent");
      for (const r of rules().filter((x) => x.selectors.some((s) => s.startsWith(button)))) {
        expect(declaration(r.body, "opacity"), r.selectors.join(", ")).toBeUndefined();
      }
    });

    it(`${button}:disabled comes after ${button}:hover, so a disabled button's hover stays flat`, () => {
      const hover = rules().find((r) => r.selectors.includes(`${button}:hover`));
      const disabled = rules().find((r) => r.selectors.includes(`${button}:disabled`));
      expect(hover).toBeDefined();
      expect(disabled?.at).toBeGreaterThan(hover?.at ?? Number.POSITIVE_INFINITY);
    });
  }
});
