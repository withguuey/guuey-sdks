// @vitest-environment jsdom
/**
 * guuey#2367 on web: code fences are highlighted with the token classes (text
 * only, never markup), and a tool result reads in full: JSON highlighted, a cut
 * result opens with "Show all", and copy takes the whole text.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { Markdown } from "./markdown.js";
import { DefaultDataResult, type TranscriptItemContext } from "./components.js";
import type { DataResultItem } from "../types.js";
import { defaultChatStrings } from "../strings.js";

afterEach(cleanup);

describe("code fences are highlighted (guuey#2367)", () => {
  it("a json fence gets key/string/number token spans, and the code text is unchanged", () => {
    const { container } = render(<Markdown text={'```json\n{"a": "x", "n": 1}\n```'} />);
    const pre = container.querySelector("pre.guuey-chat-code-fence")!;
    expect(pre.textContent).toBe('{"a": "x", "n": 1}');
    expect(pre.querySelector(".guuey-chat-tok-key")?.textContent).toBe('"a"');
    expect(pre.querySelector(".guuey-chat-tok-string")?.textContent).toBe('"x"');
    expect(pre.querySelector(".guuey-chat-tok-number")?.textContent).toBe("1");
  });

  it("an unknown language renders bare text, exactly as before", () => {
    const { container } = render(<Markdown text={"```sql\nSELECT 1;\n```"} />);
    const pre = container.querySelector("pre.guuey-chat-code-fence")!;
    expect(pre.textContent).toBe("SELECT 1;");
    expect(pre.querySelector(".guuey-chat-tok")).toBeNull();
  });

  it("code that looks like markup stays text", () => {
    const { container } = render(<Markdown text={"```js\nconst x = '<img src=x onerror=alert(1)>';\n```"} />);
    expect(container.querySelector("pre img")).toBeNull();
    expect(container.querySelector("pre")!.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

function ctx(): TranscriptItemContext {
  return { strings: defaultChatStrings, onToggle: vi.fn(), resolvedMounts: new Map(), onViewPhase: vi.fn() };
}

const base: DataResultItem = {
  kind: "data-result",
  key: "k1",
  expanded: true,
  preview: '{\n  "a": 1',
  byteCount: 40,
  state: "small",
  showBytes: false,
};

describe("a readable tool result on web (guuey#2367 gap 3)", () => {
  it("JSON results are highlighted", () => {
    const { container } = render(
      <DefaultDataResult item={{ ...base, preview: '{\n  "a": 1\n}', lang: "json" }} ctx={ctx()} />,
    );
    expect(container.querySelector(".guuey-chat-tok-key")?.textContent).toBe('"a"');
  });

  it("a cut result shows its preview, then its whole text on Show all, and back on Show less", () => {
    const full = '{\n  "a": 1,\n  "b": 2\n}';
    const { container, getByRole } = render(
      <DefaultDataResult item={{ ...base, full, lang: "json" }} ctx={ctx()} />,
    );
    const pre = () => container.querySelector("pre.guuey-chat-data-preview")!.textContent;
    expect(pre()).toBe(base.preview);
    const more = getByRole("button", { name: "Show all" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(pre()).toBe(full);
    expect(getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("no Show all when nothing was cut (an old plan without `full` renders exactly as before)", () => {
    const { queryByRole } = render(<DefaultDataResult item={base} ctx={ctx()} />);
    expect(queryByRole("button", { name: "Show all" })).toBeNull();
  });
});
