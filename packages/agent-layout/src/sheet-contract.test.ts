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

/** The rule block for one selector (first match) within `source`. */
function block(selector: string, source: string = sheet): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector missing from sheet: ${selector}`);
  return source.slice(start, source.indexOf("}", start));
}

/** The body of one `@media` block, matched by its exact prelude. */
function media(prelude: string): string {
  const head = sheet.indexOf(`@media ${prelude} {`);
  if (head === -1) throw new Error(`media block missing from sheet: ${prelude}`);
  const open = sheet.indexOf("{", head);
  let depth = 0;
  for (let i = open; i < sheet.length; i += 1) {
    if (sheet[i] === "{") depth += 1;
    if (sheet[i] === "}") depth -= 1;
    if (depth === 0) return sheet.slice(open + 1, i);
  }
  throw new Error(`media block never closes: ${prelude}`);
}

const DRAWER = "(max-width: 1023.98px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const OPEN_SIDEBAR = '.guuey-layout-shell[data-drawer-open="true"] .guuey-layout-sidebar';

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

  it("the pane owns its scroll context (the right panel scrolls within itself)", () => {
    expect(block(".guuey-layout-pane")).toContain("overflow: auto");
  });

  it("the agent panel takes the sidebar's remaining lower space (stuck on its bottom)", () => {
    const agent = block(".guuey-layout-panel-agent");
    expect(agent).toMatch(/flex: var\(--guuey-layout-agent-panel-flex, 1\)/);
    // The app panel never GROWS: free space stays the agent panel's.
    expect(block(".guuey-layout-panel-app")).toMatch(/flex: 0 1 auto/);
  });
});

describe("guuey#2450 — a tall nav scrolls; the agent panel is never crushed", () => {
  it("the app panel is the sidebar's scroller: it may shrink below its content and scrolls what it cannot show", () => {
    const app = block(".guuey-layout-panel-app");
    expect(app).toMatch(/flex: 0 1 auto/);
    expect(app).toContain("min-height: 0");
    expect(app).toContain("overflow-y: auto");
    expect(app).not.toContain("flex-shrink: 0");
  });

  it("the agent panel keeps a floor behind the --guuey-layout-agent-panel-min seam", () => {
    expect(block(".guuey-layout-panel-agent")).toMatch(
      /min-height: var\(--guuey-layout-agent-panel-min, \d+px\)/,
    );
  });

  it("the overflow affordance: a 24px bottom-edge fade in the panel's own tone, only while the lib says content is hidden", () => {
    const fade = block('.guuey-layout-panel-app[data-overflow="true"]::after');
    expect(fade).toContain("position: sticky");
    expect(fade).toContain("inset-block-end: 0");
    expect(fade).toContain("block-size: 24px");
    // Paints over the last 24px of content; never adds layout height.
    expect(fade).toContain("margin-block-start: -24px");
    expect(fade).toContain("linear-gradient(to top, var(--guuey-layout-tone-upper), transparent)");
    expect(fade).toContain("pointer-events: none");
    // No unconditional fade: the pseudo-element exists only under the flag.
    expect(sheet).not.toMatch(/\.guuey-layout-panel-app::after/);
  });
});

describe("guuey#2450 — a closed drawer casts no shadow", () => {
  it("the parked drawer carries no box-shadow (a 24px blur at -100% bleeds onto the pane)", () => {
    expect(block(".guuey-layout-sidebar", media(DRAWER))).not.toContain("box-shadow");
  });

  it("the shadow belongs to the open state only", () => {
    expect(block(OPEN_SIDEBAR, media(DRAWER))).toContain("box-shadow: 0 0 24px rgba(0, 0, 0, 0.25)");
  });
});

describe("guuey#2450 — a closed drawer holds no focus", () => {
  it("the parked drawer is visibility:hidden — its links leave the tab order — after the slide-out plays", () => {
    const closed = block(".guuey-layout-sidebar", media(DRAWER));
    expect(closed).toContain("visibility: hidden");
    expect(closed).toContain(
      "transition:\n      transform var(--guuey-layout-tone-transition) ease-out,\n      visibility 0s linear var(--guuey-layout-tone-transition)",
    );
  });

  it("the open drawer is visible at once (visibility delay 0s), without restating the shorthand", () => {
    const open = block(OPEN_SIDEBAR, media(DRAWER));
    expect(open).toContain("visibility: visible");
    expect(open).toContain("transition-delay: 0s");
    // A `transition:` shorthand here (higher specificity) would revive the
    // slide under reduced motion; only the delay may change.
    expect(open).not.toMatch(/transition:/);
  });

  it("reduced motion still zeroes the drawer's transition (later in the sheet, same specificity), so it snaps", () => {
    expect(block(".guuey-layout-sidebar", media(REDUCED_MOTION))).toContain("transition: none");
    expect(sheet.indexOf(`@media ${REDUCED_MOTION}`)).toBeGreaterThan(sheet.indexOf(`@media ${DRAWER}`));
  });

  it("the desktop sidebar is never hidden: the rule lives only in the drawer block", () => {
    expect(block(".guuey-layout-sidebar")).not.toContain("visibility");
  });
});

describe("guuey#2430 — the drawer toggle meets the 44px phone tap floor", () => {
  const toggle = (): string => block(".guuey-layout-drawer-toggle", media(DRAWER));

  it("a 44x44 hit area; the mark stays quiet (radius 8, no glyph growth)", () => {
    expect(toggle()).toContain("min-width: 44px");
    expect(toggle()).toContain("min-height: 44px");
    expect(toggle()).toContain("border-radius: 8px");
    expect(toggle()).not.toMatch(/font-size/);
  });

  it("inset 10px plus the device's safe area, so the band under it stays 64px (10 + 44 + 10)", () => {
    expect(toggle()).toContain("inset-block-start: calc(10px + env(safe-area-inset-top))");
    expect(toggle()).toContain("inset-inline-start: calc(10px + env(safe-area-inset-left))");
  });
});
