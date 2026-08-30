// @vitest-environment jsdom
/**
 * The sanitizer boundary's security review, as tests (spec §3.1): every
 * classic XSS vector through agent-authored markdown must come out inert.
 * The pipeline is @silverprotocol/richtext's typed AST — raw HTML is
 * structurally unrepresentable — so each assertion here pins a property
 * the architecture already guarantees, against regression by pipeline
 * swap.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render , cleanup } from "@testing-library/react";
import { Markdown } from "./markdown.js";

afterEach(cleanup);

describe("Markdown sanitizer boundary", () => {
  it("renders raw HTML as literal text — script/img/iframe never become elements", () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script> and <img src=x onerror="alert(2)"> and <iframe src="https://evil.test">'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("refuses javascript:, data:, and vbscript: link targets — styled text, no anchor", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x"]) {
      const { container, unmount } = render(<Markdown text={`[click me](${href})`} />);
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).toContain("click me");
      unmount();
    }
  });

  it("navigable links are https-class only and carry the noopener/noreferrer + _blank policy", () => {
    const { container } = render(<Markdown text="[docs](https://docs.guuey.com/sdk)" />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://docs.guuey.com/sdk");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("has no image syntax at all — markdown image syntax renders as text (F5 holds structurally)", () => {
    const { container } = render(<Markdown text="![tracker](https://evil.test/pixel.png)" />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("never uses dangerouslySetInnerHTML (bold/code/lists arrive as real elements)", () => {
    const { container } = render(<Markdown text={"**bold** `code`\n\n- item"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("li")?.textContent).toBe("item");
  });

  it("streams tolerantly: an unclosed emphasis mid-delta renders as formatted-so-far", () => {
    const { container } = render(<Markdown text="**bol" />);
    expect(container.querySelector("strong")?.textContent).toBe("bol");
  });
});

describe("bare-URL autolink (guuey#515)", () => {
  it("linkifies a plain https URL in prose with the same rel/target policy as explicit links", () => {
    const { container } = render(
      <Markdown text="More: https://docs.guuey.com/hosting/ and https://docs.guuey.com/getting-started/" />,
    );
    const anchors = [...container.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
      "https://docs.guuey.com/hosting/",
      "https://docs.guuey.com/getting-started/",
    ]);
    for (const a of anchors) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });

  it("keeps trailing punctuation as prose — the sentence dot never enters the href", () => {
    const { container } = render(<Markdown text="See https://guuey.com. Then decide." />);
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://guuey.com");
    expect(container.textContent).toBe("See https://guuey.com. Then decide.");
  });

  it("keeps a balanced closing paren inside the URL (wiki-style paths)", () => {
    const { container } = render(
      <Markdown text="(see https://en.wikipedia.org/wiki/Agent_(economics)) for background" />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://en.wikipedia.org/wiki/Agent_(economics)",
    );
  });

  it("does NOT linkify schemeless hosts or non-http schemes — the scheme is the gate", () => {
    const { container } = render(
      <Markdown text="try www.guuey.com or javascript:alert(1) or ftp://files.test" />,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("leaves code spans untouched — a URL in backticks stays literal", () => {
    const { container } = render(<Markdown text="run `curl https://api.guuey.com/v1` locally" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("curl https://api.guuey.com/v1");
  });
});
