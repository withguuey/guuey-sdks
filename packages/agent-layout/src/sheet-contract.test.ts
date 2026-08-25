/**
 * The stylesheet's load-bearing physics, pinned as a CONTRACT (guuey#429).
 * jsdom performs no layout, so the sheet's rules are asserted directly —
 * the same posture as the fs-contract sync guards: a refactor that drops a
 * physics rule fails HERE, not in an adopter's viewport.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const sheet = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

/** The rule block for one selector (first match). */
function block(selector: string): string {
  const start = sheet.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector missing from sheet: ${selector}`);
  return sheet.slice(start, sheet.indexOf("}", start));
}

describe("guuey#429 — the shell is viewport-pinned by default", () => {
  it("the root establishes the height chain itself: dvh default behind the --guuey-layout-height seam, vh fallback first", () => {
    const root = block(".guuey-agent-layout");
    const vh = root.indexOf("height: var(--guuey-layout-height, 100vh)");
    const dvh = root.indexOf("height: var(--guuey-layout-height, 100dvh)");
    expect(vh).toBeGreaterThan(-1);
    expect(dvh).toBeGreaterThan(vh); // dvh wins where supported; vh is the fallback
  });

  it("the root clips — content can only scroll inside the panels' own scroll contexts, never the page", () => {
    expect(block(".guuey-agent-layout")).toContain("overflow: hidden");
  });

  it("the shell's grid row is EXPLICIT minmax(0,1fr) — the implicit auto row sizes to content and defeats every bounded child (console's #429 adjudication)", () => {
    expect(block(".guuey-layout-shell")).toContain("grid-template-rows: minmax(0, 1fr)");
  });

  it("the pane owns its scroll context (the founder's rule: the right panel scrolls within itself)", () => {
    expect(block(".guuey-layout-pane")).toContain("overflow: auto");
  });

  it("the agent panel takes the sidebar's remaining lower space (stuck on its bottom)", () => {
    const agent = block(".guuey-layout-panel-agent");
    expect(agent).toMatch(/flex: var\(--guuey-layout-agent-panel-flex, 1\)/);
    expect(block(".guuey-layout-panel-app")).toContain("flex-shrink: 0");
  });
});
