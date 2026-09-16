// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ensureFacesInDocument, facesCss } from "./faces.js";

/**
 * guuey#1195 — the face transport's two halves: the `@font-face` text for a
 * theme's declared faces, and its once-per-document registration.
 */
describe("facesCss (guuey#1195)", () => {
  it("one @font-face per admitted face — quoted family, url() src, the stated descriptors, font-display swap unless stated", () => {
    expect(
      facesCss([
        { family: "Archivo", src: "https://fonts.gstatic.com/s/archivo/v1/a.woff2", weight: "400" },
        { family: 'New "Sreader"', src: "https://fonts.gstatic.com/s/newsreader/v1/n.woff2", weight: "400 700", style: "italic", display: "optional" },
      ]),
    ).toBe(
      '@font-face{font-family:"Archivo";src:url("https://fonts.gstatic.com/s/archivo/v1/a.woff2");font-weight:400;font-display:swap}\n' +
        '@font-face{font-family:"New Sreader";src:url("https://fonts.gstatic.com/s/newsreader/v1/n.woff2");font-weight:400 700;font-style:italic;font-display:optional}',
    );
  });

  it("drops a non-https src, a src carrying a quote / paren / semicolon, a blank family, and a bad descriptor; dedupes a repeated face; empty for none", () => {
    expect(facesCss(undefined)).toBe("");
    expect(facesCss([])).toBe("");
    expect(facesCss([{ family: "X", src: "http://example.com/x.woff2" }])).toBe("");
    expect(facesCss([{ family: "X", src: 'https://example.com/x.woff2")}body{color:red' }])).toBe("");
    expect(facesCss([{ family: "   ", src: "https://example.com/x.woff2" }])).toBe("");
    expect(facesCss([{ family: "X", src: "https://example.com/x.woff2", weight: "400;color:red" }])).toBe(
      '@font-face{font-family:"X";src:url("https://example.com/x.woff2");font-display:swap}',
    );
    const twice = facesCss([
      { family: "X", src: "https://example.com/x.woff2" },
      { family: "X", src: "https://example.com/x.woff2" },
    ]);
    expect(twice.split("@font-face").length - 1).toBe(1);
  });
});

describe("ensureFacesInDocument (guuey#1195)", () => {
  afterEach(() => {
    for (const el of Array.from(document.head.querySelectorAll("style[data-guuey-faces]"))) el.remove();
  });

  it("registers the rules once per document (jsdom has no constructed sheets → a marked <style> in <head>); a repeat adds nothing; a new set adds one more", () => {
    const css = facesCss([{ family: "Archivo", src: "https://fonts.gstatic.com/s/archivo/v1/a.woff2" }]);
    ensureFacesInDocument(document, css);
    ensureFacesInDocument(document, css);
    const styles = document.head.querySelectorAll("style[data-guuey-faces]");
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toContain('font-family:"Archivo"');
    ensureFacesInDocument(document, facesCss([{ family: "Other", src: "https://fonts.gstatic.com/s/o/v1/o.woff2" }]));
    expect(document.head.querySelectorAll("style[data-guuey-faces]")).toHaveLength(2);
    ensureFacesInDocument(document, "");
    expect(document.head.querySelectorAll("style[data-guuey-faces]")).toHaveLength(2);
  });
});
