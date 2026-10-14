/**
 * guuey#2304 — the kit has ONE focus ring for its controls: the 2px accent
 * outline plus a 1px ink hairline, so the indicator clears 3:1 on any ground
 * and with any builder accent. Read from the shipped stylesheet.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every [selectors, body] pair in the sheet (no nesting in this file). */
function rules(): Array<[string[], string]> {
  const out: Array<[string[], string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    out.push([(m[1] ?? "").split(",").map((s) => s.trim()), m[2] ?? ""]);
  }
  return out;
}

const CONTROLS = [
  ".guuey-chat-toggle",
  ".guuey-chat-prompt-actions button",
  ".guuey-chat-jump",
  ".guuey-chat-show-earlier",
  ".guuey-chat-copy",
  ".guuey-chat-retry",
  ".guuey-chat-header-close",
  ".guuey-chat-code-copy",
  ".guuey-chat-composer-input",
];

describe("the kit's focus ring (guuey#2304)", () => {
  it("every control's :focus-visible is the ONE shared rule: accent outline + ink hairline", () => {
    const shared = rules().filter(([sels]) => CONTROLS.every((c) => sels.includes(`${c}:focus-visible`)));
    expect(shared).toHaveLength(1);
    const body = shared[0]![1];
    expect(body).toMatch(/outline:\s*2px solid var\(--guuey-chat-accent/);
    expect(body).toMatch(/box-shadow:\s*0 0 0 1px var\(--guuey-chat-ink/);
  });

  it("no other rule paints an accent-only outline on those controls", () => {
    for (const [sels, body] of rules()) {
      if (!/outline:\s*2px solid/.test(body)) continue;
      const hitsControl = sels.some((s) => CONTROLS.some((c) => s === `${c}:focus-visible`));
      if (hitsControl) expect(body).toMatch(/box-shadow:\s*0 0 0 1px/);
    }
  });

  it("nothing cancels the ring: no rule sets `outline: none` on a control's focus", () => {
    for (const [sels, body] of rules()) {
      const onFocus = sels.some((s) => CONTROLS.some((c) => s === `${c}:focus` || s === `${c}:focus-visible`));
      if (onFocus) expect(body, sels.join(", ")).not.toMatch(/outline:\s*none/);
    }
  });

  it("the composer keeps its accent border on focus beside the shared ring", () => {
    const focus = rules().filter(([sels]) => sels.length === 1 && sels[0] === ".guuey-chat-composer-input:focus");
    expect(focus).toHaveLength(1);
    expect(focus[0]![1]).toMatch(/border-color:\s*var\(--guuey-chat-accent/);
  });

  it("the jump chip keeps its drop shadow under the hairline when focused", () => {
    const jump = rules().filter(([sels]) => sels.length === 1 && sels[0] === ".guuey-chat-jump:focus-visible");
    expect(jump).toHaveLength(1);
    expect(jump[0]![1]).toMatch(/0 0 0 1px var\(--guuey-chat-ink[^)]*\)\),\s*0 2px 8px/);
  });
});
