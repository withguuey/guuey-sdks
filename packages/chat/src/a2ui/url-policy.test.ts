/**
 * guuey#2381 — §7.2 policy A (what an A2UI surface may LOAD) and §7.3 links
 * (what it may OPEN): one function each, one table each (spec §14 S1 (h)).
 */
import { describe, expect, it } from "vitest";
import { a2uiImageDisplay, httpsLink, isPolicyAImageSrc } from "./url-policy.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("isPolicyAImageSrc (policy A, ruling 3)", () => {
  const allowed: Array<[string, string]> = [
    ["a png data: URL", PNG],
    ["a jpeg data: URL", "data:image/jpeg;base64,/9j/4AAQ"],
    ["a gif data: URL", "data:image/gif;base64,R0lGODlh"],
    ["a webp data: URL", "data:image/webp;base64,UklGRg=="],
    ["a blob: URL", "blob:https://app.example.com/6f0c0bb2-6f6e-4b38-9d77-6a4a0d1b2b50"],
    ["the bare media host", "https://guueyusercontent.com/m/a.png"],
    ["a media subdomain", "https://dev.guueyusercontent.com/m/a.png?sig=abc"],
    ["an upper-case host (the URL parser lower-cases it)", "https://CDN.GuueyUserContent.com/a.png"],
    ["the default port spelled out", "https://cdn.guueyusercontent.com:443/a.png"],
  ];
  const refused: Array<[string, string]> = [
    ["an svg data: URL (script surface)", "data:image/svg+xml;base64,PHN2Zz4="],
    ["an html data: URL", "data:text/html;base64,PGI+"],
    ["a data: URL that is not base64", "data:image/png,rawbytes"],
    ["a data: URL with characters outside base64", "data:image/png;base64,!!!"],
    ["http on the media host", "http://guueyusercontent.com/a.png"],
    ["another https host", "https://example.com/a.png"],
    ["the media host as a prefix of another host", "https://guueyusercontent.com.evil.example/a.png"],
    ["the media host as a suffix without a dot", "https://evilguueyusercontent.com/a.png"],
    ["a trailing-dot host", "https://guueyusercontent.com./a.png"],
    ["a Cyrillic lookalike host (IDNA-normalized, not equal)", "https://guueyusercоntent.com/a.png"],
    ["userinfo on the media host", "https://user:pw@cdn.guueyusercontent.com/a.png"],
    ["a username only", "https://user@cdn.guueyusercontent.com/a.png"],
    ["a non-default port", "https://cdn.guueyusercontent.com:8443/a.png"],
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
    ["a relative path", "/m/a.png"],
    ["an unparsable string", "not a url"],
    ["the empty string", ""],
  ];
  for (const [what, src] of allowed) it(`allows ${what}`, () => expect(isPolicyAImageSrc(src)).toBe(true));
  for (const [what, src] of refused) it(`refuses ${what}`, () => expect(isPolicyAImageSrc(src)).toBe(false));

  it("an https or blob: URL at 2 048 units is allowed, one over is refused", () => {
    const base = "https://cdn.guueyusercontent.com/";
    const at = base + "a".repeat(2048 - base.length);
    expect(at).toHaveLength(2048);
    expect(isPolicyAImageSrc(at)).toBe(true);
    expect(isPolicyAImageSrc(at + "a")).toBe(false);
    const blob = "blob:https://app.example.com/";
    expect(isPolicyAImageSrc(blob + "b".repeat(2048 - blob.length))).toBe(true);
    expect(isPolicyAImageSrc(blob + "b".repeat(2049 - blob.length))).toBe(false);
  });

  it("a data: image is bounded by the carrier, not by the URL cap", () => {
    expect(isPolicyAImageSrc(`data:image/png;base64,${"A".repeat(4000)}`)).toBe(true);
  });
});

describe("httpsLink (§7.3: https only, no userinfo, the host shown)", () => {
  it("an https URL opens, with its host", () => {
    expect(httpsLink("https://example.com/path?q=1")).toEqual({ url: "https://example.com/path?q=1", host: "example.com" });
    expect(httpsLink("https://example.com:8443/x")).toEqual({ url: "https://example.com:8443/x", host: "example.com:8443" });
  });

  it("an IDN host is shown in its ASCII form, so a lookalike cannot pass for another host", () => {
    expect(httpsLink("https://exаmple.com/")?.host).toBe("xn--exmple-4nf.com");
  });

  const inert = [
    "http://example.com/",
    "mailto:a@example.com",
    "tel:+1555",
    "javascript:alert(1)",
    "data:text/html;base64,PGI+",
    "/relative",
    "https://user:pw@example.com/",
    "https://user@example.com/",
    "not a url",
    "",
  ];
  for (const url of inert) it(`refuses ${JSON.stringify(url)}`, () => expect(httpsLink(url)).toBeNull());

  it("2 048 units is the bound", () => {
    const base = "https://example.com/";
    const at = base + "a".repeat(2048 - base.length);
    expect(httpsLink(at)).not.toBeNull();
    expect(httpsLink(at + "a")).toBeNull();
  });
});

describe("a2uiImageDisplay (load, open-link chip, or plain chip)", () => {
  it("a policy-A src loads", () => {
    expect(a2uiImageDisplay(PNG)).toEqual({ kind: "image", src: PNG });
  });

  it("an off-policy https src is a chip that only offers to open it (never fetched)", () => {
    expect(a2uiImageDisplay("https://tracker.example/pixel.gif")).toEqual({
      kind: "link",
      url: "https://tracker.example/pixel.gif",
      host: "tracker.example",
    });
  });

  it("anything else is a plain chip", () => {
    expect(a2uiImageDisplay("http://example.com/a.png")).toEqual({ kind: "chip" });
    expect(a2uiImageDisplay("data:image/svg+xml;base64,PHN2Zz4=")).toEqual({ kind: "chip" });
    expect(a2uiImageDisplay("javascript:alert(1)")).toEqual({ kind: "chip" });
  });
});
