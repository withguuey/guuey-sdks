// @vitest-environment jsdom
/**
 * guuey#2554 — the host's scroll control on <Transcript>: the `follow` policy, the handle
 * (`scrollToItem`, `scrollToEnd`, `element`), `onAtEndChange` and `jumpToLatest`. With none of
 * them passed, nothing changes for existing hosts (transcript.test.tsx pins today's behaviour).
 */
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calmPolicy } from "../policy.js";
import { planTranscript } from "../plan.js";
import type { TranscriptInputs } from "../types.js";
import { viewNeverHandshakes } from "../corpus/fixtures.js";
import { Transcript, type TranscriptHandle } from "./transcript.js";

const PANEL = 500;
const ITEM_H = 300;
let content = 2000;
const restore: Array<() => void> = [];
/** The live ResizeObserver callbacks, so a test can fire "content resized". */
let resizeCallbacks: Array<() => void> = [];

function planOf(messageCount: number) {
  const inputs: TranscriptInputs = {
    result: null,
    assistantText: "",
    status: "ready",
    statusElapsedMs: 0,
    activeTool: null,
    error: null,
    prompts: [],
    messages: Array.from({ length: messageCount }, (_, i) =>
      i % 2 === 0
        ? ({ role: "user", text: `question ${i}` } as const)
        : ({ role: "assistant", text: `answer ${i}` } as const),
    ),
  };
  return planTranscript(inputs, calmPolicy());
}

const noopCtx = {
  onToggle: () => {},
  resolvedMounts: new Map<string, never>(),
  onViewPhase: () => {},
};

/** Geometry: the scroller is PANEL tall over `content`; column child i sits at i * ITEM_H. */
function mockLayout(): void {
  const proto = HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  const rect = Element.prototype.getBoundingClientRect;
  const isScroller = (el: Element): boolean => el.classList.contains("guuey-chat-scroller");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? content : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return isScroller(this) ? PANEL : 0;
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (isScroller(this)) return new DOMRect(0, 0, 300, PANEL);
    const column = this.parentElement;
    const scroller = this.closest(".guuey-chat-scroller");
    if (column === null || !column.classList.contains("guuey-chat-column") || !(scroller instanceof HTMLElement)) {
      return new DOMRect(0, 0, 0, 0);
    }
    const i = Array.from(column.children).indexOf(this);
    return new DOMRect(0, i * ITEM_H - scroller.scrollTop, 300, ITEM_H);
  };
  restore.push(() => {
    if (scrollHeight !== undefined) Object.defineProperty(proto, "scrollHeight", scrollHeight);
    if (clientHeight !== undefined) Object.defineProperty(proto, "clientHeight", clientHeight);
    Element.prototype.getBoundingClientRect = rect;
  });
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(): void {
        resizeCallbacks.push(this.cb);
      }
      disconnect(): void {
        resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
      }
    },
  );
  mockLayout();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  while (restore.length > 0) restore.pop()?.();
  content = 2000;
});

const scrollerOf = (container: HTMLElement): HTMLElement => {
  const el = container.querySelector(".guuey-chat-scroller");
  if (!(el instanceof HTMLElement)) throw new Error("no scroller");
  return el;
};
const resize = (): void =>
  act(() => {
    for (const cb of resizeCallbacks) cb();
  });

describe('follow="off" (guuey#2554)', () => {
  it("a streaming turn never moves the viewport: scrollTop holds through every render and resize", () => {
    const plan = planOf(4);
    const { container, rerender } = render(<Transcript plan={plan} follow="off" {...noopCtx} />);
    const el = scrollerOf(container);
    expect(el.scrollTop).toBe(0);
    el.scrollTop = 120;
    fireEvent.scroll(el);
    for (const grown of [2400, 3100, 4000]) {
      content = grown;
      rerender(<Transcript plan={{ ...plan }} follow="off" {...noopCtx} />);
      resize();
      expect(el.scrollTop).toBe(120);
    }
  });

  it("reaching the bottom by hand does not start following", () => {
    const plan = planOf(4);
    const { container, rerender } = render(<Transcript plan={plan} follow="off" {...noopCtx} />);
    const el = scrollerOf(container);
    el.scrollTop = content - PANEL;
    fireEvent.scroll(el);
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} follow="off" {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(2000 - PANEL);
  });

  it("scrollToEnd goes to the end and follows from there, until the reader scrolls away", () => {
    const plan = planOf(4);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => handle.current?.scrollToEnd());
    // jsdom has no clamp: the end is written as scrollHeight.
    expect(el.scrollTop).toBe(2000);
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} follow="off" handleRef={handle} {...noopCtx} />);
    expect(el.scrollTop).toBe(3000 - PANEL);
    el.scrollTop = 100;
    fireEvent.scroll(el);
    content = 3600;
    rerender(<Transcript plan={{ ...plan }} follow="off" handleRef={handle} {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(100);
  });
});

describe("scrollToItem (guuey#2554)", () => {
  it("align top puts the item's top at the viewport's top, less the offset, and stops following", () => {
    const plan = planOf(6);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    const key = plan.items[2]!.key;
    let ok = false;
    act(() => {
      ok = handle.current?.scrollToItem(key, { align: "top", offset: 20 }) ?? false;
    });
    expect(ok).toBe(true);
    expect(el.scrollTop).toBe(2 * ITEM_H - 20);
    // The host placed the view: a later render does not pull it to the tail.
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} handleRef={handle} {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(2 * ITEM_H - 20);
  });

  it("align end puts the item's bottom at the viewport's bottom", () => {
    const plan = planOf(6);
    const handle = createRef<TranscriptHandle>();
    const { container } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    act(() => {
      handle.current?.scrollToItem(plan.items[3]!.key, { align: "end" });
    });
    expect(scrollerOf(container).scrollTop).toBe(3 * ITEM_H + ITEM_H - PANEL);
  });

  it("answers false, without scrolling, for an unknown key", () => {
    const handle = createRef<TranscriptHandle>();
    const { container } = render(<Transcript plan={planOf(4)} follow="off" handleRef={handle} {...noopCtx} />);
    let ok = true;
    act(() => {
      ok = handle.current?.scrollToItem("no-such-key") ?? true;
    });
    expect(ok).toBe(false);
    expect(scrollerOf(container).scrollTop).toBe(0);
  });

  it("answers false when the DOM does not line up with the plan (a component rendering two elements)", () => {
    const plan = planOf(4);
    const handle = createRef<TranscriptHandle>();
    render(
      <Transcript
        plan={plan}
        follow="off"
        handleRef={handle}
        components={{ userMessage: () => (<><div /><div /></>) }}
        {...noopCtx}
      />,
    );
    let ok = true;
    act(() => {
      ok = handle.current?.scrollToItem(plan.items[1]!.key) ?? true;
    });
    expect(ok).toBe(false);
  });

  it("the handle exposes the scroll element", () => {
    const handle = createRef<TranscriptHandle>();
    const { container } = render(<Transcript plan={planOf(2)} handleRef={handle} {...noopCtx} />);
    expect(handle.current?.element).toBe(scrollerOf(container));
  });
});

describe("onAtEndChange and jumpToLatest (guuey#2554)", () => {
  it('fires as the tail enters and leaves the viewport under follow="off", once per change', () => {
    const plan = planOf(4);
    const seen: boolean[] = [];
    const { container, rerender } = render(
      <Transcript plan={plan} follow="off" onAtEndChange={(v) => seen.push(v)} {...noopCtx} />,
    );
    const el = scrollerOf(container);
    expect(seen).toEqual([false]);
    el.scrollTop = content - PANEL;
    fireEvent.scroll(el);
    fireEvent.scroll(el);
    expect(seen).toEqual([false, true]);
    // The answer grows past the fold: the tail leaves the viewport with no scroll event.
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} follow="off" onAtEndChange={(v) => seen.push(v)} {...noopCtx} />);
    resize();
    expect(seen).toEqual([false, true, false]);
  });

  it("fires on a content resize with no render (an image loading), not only on a new plan", () => {
    const seen: boolean[] = [];
    const { container } = render(
      <Transcript plan={planOf(4)} follow="off" onAtEndChange={(v) => seen.push(v)} {...noopCtx} />,
    );
    const el = scrollerOf(container);
    el.scrollTop = content - PANEL;
    fireEvent.scroll(el);
    expect(seen).toEqual([false, true]);
    content = 2600;
    resize();
    expect(seen).toEqual([false, true, false]);
  });

  it('fires under the default "tail" policy too', () => {
    const seen: boolean[] = [];
    const { container } = render(<Transcript plan={planOf(4)} onAtEndChange={(v) => seen.push(v)} {...noopCtx} />);
    const el = scrollerOf(container);
    // Following put the view at the end on mount.
    expect(seen).toEqual([true]);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(seen).toEqual([true, false]);
  });

  it("jumpToLatest={false} hides the built-in chip; the default shows it", () => {
    const { container, rerender } = render(<Transcript plan={planOf(4)} jumpToLatest={false} {...noopCtx} />);
    const el = scrollerOf(container);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    rerender(<Transcript plan={planOf(4)} {...noopCtx} />);
    fireEvent.scroll(el);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });
});

describe("cto read fixes (guuey#2554)", () => {
  it("STOP-1: scrollToItem finds the user row and both cards on the kit's own calm transcript with a view", () => {
    const plan = planTranscript(viewNeverHandshakes(), calmPolicy());
    // The fixture is the shape under test: an attributed tool item the default slot renders as nothing.
    expect(plan.items.some((i) => i.kind === "tool" && i.attribution)).toBe(true);
    const handle = createRef<TranscriptHandle>();
    render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const keys = plan.items.filter((i) => i.kind !== "tool").map((i) => i.key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      let ok = false;
      act(() => {
        ok = handle.current?.scrollToItem(key) ?? false;
      });
      expect(ok, key).toBe(true);
    }
  });

  it("STOP-1: a host's own tool component is counted as one element", () => {
    const plan = planTranscript(viewNeverHandshakes(), calmPolicy());
    const handle = createRef<TranscriptHandle>();
    render(
      <Transcript plan={plan} follow="off" handleRef={handle} components={{ tool: () => <div className="host-tool" /> }} {...noopCtx} />,
    );
    let ok = false;
    act(() => {
      ok = handle.current?.scrollToItem(plan.items[plan.items.length - 1]!.key) ?? false;
    });
    expect(ok).toBe(true);
  });

  it('STOP-2: a SMOOTH scrollToEnd under "off" keeps following through its intermediate frames', () => {
    const plan = planOf(4);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => handle.current?.scrollToEnd({ behavior: "smooth" }));
    // The browser's smooth scroll emits frames on its way down, far from the end.
    for (const top of [300, 800, 1200, 2000 - PANEL]) {
      el.scrollTop = top;
      fireEvent.scroll(el);
    }
    content = 2600;
    rerender(<Transcript plan={{ ...plan }} follow="off" handleRef={handle} {...noopCtx} />);
    expect(el.scrollTop).toBe(2600 - PANEL);
  });

  it("STOP-2: the reader scrolling back up during that smooth scroll takes over", () => {
    const plan = planOf(4);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => handle.current?.scrollToEnd({ behavior: "smooth" }));
    for (const top of [300, 800, 400]) {
      el.scrollTop = top;
      fireEvent.scroll(el);
    }
    content = 2600;
    rerender(<Transcript plan={{ ...plan }} follow="off" handleRef={handle} {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(400);
  });

  it("MED-1: a callback handleRef is called once, not on every render", () => {
    const plan = planOf(4);
    const calls: Array<TranscriptHandle | null> = [];
    const cb = (h: TranscriptHandle | null): void => {
      calls.push(h);
    };
    const { rerender } = render(<Transcript plan={plan} handleRef={cb} {...noopCtx} />);
    rerender(<Transcript plan={{ ...plan }} handleRef={cb} {...noopCtx} />);
    rerender(<Transcript plan={{ ...plan }} handleRef={cb} {...noopCtx} />);
    expect(calls.filter((h) => h !== null)).toHaveLength(1);
    expect(calls.filter((h) => h === null)).toHaveLength(0);
  });

  it('MED-2: switching follow from "tail" to "off" at runtime stops following at once', () => {
    const plan = planOf(4);
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    const el = scrollerOf(container);
    const followed = el.scrollTop;
    rerender(<Transcript plan={{ ...plan }} follow="off" {...noopCtx} />);
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} follow="off" {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(followed);
  });
});

describe("the recipe (transcript-scroll.ts header, guuey#2554)", () => {
  it('follow="off": the new user item goes to the top, the reply streams in place, the host\'s "↓" follows from the end', () => {
    const handle = createRef<TranscriptHandle>();
    const atEnd: boolean[] = [];
    let plan = planOf(4);
    const view = (p: typeof plan) => (
      <Transcript plan={p} follow="off" jumpToLatest={false} handleRef={handle} onAtEndChange={(v) => atEnd.push(v)} {...noopCtx} />
    );
    const { container, rerender } = render(view(plan));
    const el = scrollerOf(container);
    // A new user turn: the host scrolls it to the top once, with room for a 40px header.
    plan = planOf(5);
    rerender(view(plan));
    const userKey = plan.items[plan.items.length - 1]!.key;
    act(() => {
      handle.current?.scrollToItem(userKey, { align: "top", offset: 40 });
    });
    const placed = el.scrollTop;
    expect(placed).toBe(4 * ITEM_H - 40);
    // The reply streams in: the view never moves, and the tail leaves the viewport.
    for (const grown of [2600, 3200, 4000]) {
      content = grown;
      plan = planOf(6);
      rerender(view(plan));
      resize();
      expect(el.scrollTop).toBe(placed);
    }
    expect(atEnd[atEnd.length - 1]).toBe(false);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    // The host's own "↓": go to the end, and follow from there.
    act(() => handle.current?.scrollToEnd());
    content = 4600;
    rerender(view({ ...plan }));
    expect(el.scrollTop).toBe(4600 - PANEL);
  });
});

