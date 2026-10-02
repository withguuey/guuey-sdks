/**
 * guuey#2121 — the "Jump to latest" chip. Its label colour must never be a
 * theme token a theme may set transparent (a transparent canvas made it a
 * label-less black pill on guuey.com), and it sits on the seam between the
 * transcript and what follows, never absolutely in the transcript's corner over
 * content. Read from the shipped stylesheet, located by selector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** Every declaration block whose selector list includes exactly `.guuey-chat-jump`. */
function jumpBlocks(): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.some((s) => /(^|\s)\.guuey-chat-jump$/.test(s))) blocks.push(m[2] ?? "");
  }
  return blocks;
}

describe("the jump chip (guuey#2121)", () => {
  it("is found in the stylesheet", () => {
    expect(jumpBlocks().length).toBeGreaterThan(0);
  });

  it("never paints its label in a theme token (canvas or surface)", () => {
    for (const block of jumpBlocks()) {
      const color = /(?:^|;)\s*color:\s*([^;]+)/.exec(block)?.[1] ?? "";
      expect(color).not.toMatch(/--guuey-chat-canvas|--guuey-chat-surface/);
    }
  });

  it("never sits in the transcript's bottom-right corner; by default it is centred fully inside", () => {
    const base = jumpBlocks()[0] ?? "";
    expect(base).toMatch(/left:\s*50%/);
    expect(base).toMatch(/bottom:\s*8px/);
    expect(base).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(base).not.toMatch(/inset-inline-end/);
  });

  // cto's read: a composer-less host (guuey.com's home rep, the inline embed) makes the
  // surface its own clipping scroll box, so the seam placement applies only where a
  // composer follows: the kit's own, or a host that opts in with guuey-chat--seam.
  it("hangs half over the seam only where a composer follows", () => {
    const seam = /([^{}]+)\{([^{}]*)\}/g;
    let found = "";
    for (let m = seam.exec(css); m !== null; m = seam.exec(css)) {
      if ((m[2] ?? "").includes("translate(-50%, 50%)")) found = m[1] ?? "";
    }
    const selectors = found.split(",").map((s) => s.trim());
    expect(selectors).toEqual([".guuey-chat-surface:has(> .guuey-chat-composer) .guuey-chat-jump", ".guuey-chat--seam .guuey-chat-jump"]);
  });

  // cdo (guuey#2121): composer-less hosts get the smallest footprint, a 32px round
  // icon-only chip; the seam keeps the labelled pill.
  it("composer-less (the default): a 32px round chip showing the icon, never the label", () => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? "").trim(), body: m[2] ?? "" }));
    const sized = blocks.filter((b) => b.sel === ".guuey-chat-jump" && /width:\s*32px/.test(b.body));
    expect(sized.length).toBe(1);
    expect(sized[0]?.body).toMatch(/height:\s*32px/);
    expect(sized[0]?.body).toMatch(/padding:\s*0/);
    expect(blocks.find((b) => b.sel === ".guuey-chat-jump .guuey-chat-jump-label")?.body).toMatch(/display:\s*none/);
  });

  it("on the seam: the labelled pill, never the icon", () => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: (m[1] ?? "").replace(/\s+/g, " ").trim(), body: m[2] ?? "" }));
    const seamFaces = blocks.filter((b) => b.sel.includes(".guuey-chat--seam .guuey-chat-jump"));
    expect(seamFaces.some((b) => /width:\s*auto/.test(b.body) && /padding:\s*6px 14px/.test(b.body))).toBe(true);
    expect(seamFaces.some((b) => b.sel.includes("guuey-chat-jump-label") && /display:\s*inline/.test(b.body))).toBe(true);
    expect(seamFaces.some((b) => b.sel.includes("guuey-chat-jump-icon") && /display:\s*none/.test(b.body))).toBe(true);
  });
});

