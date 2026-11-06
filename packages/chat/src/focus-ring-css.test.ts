/**
 * guuey#2304 — the kit has ONE focus ring for its controls, one stroke: a 2px
 * cue ring 2px off the control. The cue clears 3:1 on every shipped ground
 * (theme.contrast.test.ts) and derives that way when unstated. Nothing else
 * changes on focus: no hairline, no border flip. Read from the shipped
 * stylesheet.
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
  ".guuey-chat-data-more",
  ".guuey-chat-media-open",
  ".guuey-chat-composer-attach",
  ".guuey-chat-attachment-remove",
  ".guuey-chat-composer-input",
];

describe("the kit's focus ring (guuey#2304)", () => {
  it("every control's :focus-visible is the ONE shared rule: one 2px cue ring 2px off, no hairline", () => {
    const shared = rules().filter(([sels]) => CONTROLS.every((c) => sels.includes(`${c}:focus-visible`)));
    expect(shared).toHaveLength(1);
    const body = shared[0]![1];
    expect(body).toMatch(/outline:\s*2px solid var\(--guuey-chat-cue, var\(--_guuey-chat-cue\)\)/);
    expect(body).toMatch(/outline-offset:\s*2px/);
    expect(body).not.toMatch(/box-shadow/);
  });

  it("no other rule draws a second focus stroke on a control (no outline, shadow or border change)", () => {
    for (const [sels, body] of rules()) {
      const onFocus = sels.some((s) => CONTROLS.some((c) => s === `${c}:focus` || s === `${c}:focus-visible`));
      const shared = CONTROLS.every((c) => sels.includes(`${c}:focus-visible`));
      if (onFocus && !shared) expect(body, sels.join(", ")).not.toMatch(/\b(outline|box-shadow|border)[a-z-]*\s*:/);
    }
  });

  it("nothing cancels the ring: no rule sets `outline: none` on a control's focus", () => {
    for (const [sels, body] of rules()) {
      const onFocus = sels.some((s) => CONTROLS.some((c) => s === `${c}:focus` || s === `${c}:focus-visible`));
      if (onFocus) expect(body, sels.join(", ")).not.toMatch(/outline:\s*none/);
    }
  });

  it("the composer's insertion caret is a cue stroke", () => {
    const input = rules().filter(
      ([sels, body]) => sels.length === 1 && sels[0] === ".guuey-chat-composer-input" && /caret-color/.test(body),
    );
    expect(input).toHaveLength(1);
    expect(input[0]![1]).toMatch(/caret-color:\s*var\(--guuey-chat-cue, var\(--_guuey-chat-cue\)\)/);
  });
});
