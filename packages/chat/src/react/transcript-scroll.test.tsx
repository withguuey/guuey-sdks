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
/** The scroller's own height; a test changes it to model the panel resizing (a keyboard closing). */
let panel = PANEL;
const restore: Array<() => void> = [];
/** The live ResizeObserver callbacks, so a test can fire "content resized". */
let resizeCallbacks: Array<() => void> = [];
/** How many times a ResizeObserver started observing, across the test. */
let observeCount = 0;

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
      return isScroller(this) ? panel : 0;
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
  observeCount = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(): void {
        observeCount += 1;
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
  panel = PANEL;
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

  it("the content observer is attached once: re-renders never re-observe the column or the panel, and a resize still follows", () => {
    const plan = planOf(4);
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    // The mount observes the column and the scroller itself (a panel resize refits the reserved room).
    expect(observeCount).toBe(2);
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    expect(observeCount).toBe(2);
    // The observer built at mount still follows growth seen after those renders.
    content = 3000;
    resize();
    expect(scrollerOf(container).scrollTop).toBe(content - PANEL);
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

describe("cto delta read (guuey#2554)", () => {
  it("MED-3 (declared default-path change): a chip click whose glide meets growth follows to the grown end, chip hidden", () => {
    const plan = planOf(4);
    const { container, rerender } = render(<Transcript plan={plan} {...noopCtx} />);
    const el = scrollerOf(container);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    // A mid-glide frame, far from the end, then the stream grows.
    el.scrollTop = 600;
    fireEvent.scroll(el);
    content = 2500;
    rerender(<Transcript plan={{ ...plan }} {...noopCtx} />);
    expect(el.scrollTop).toBe(2500 - PANEL);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("FOLLOW-UP: an INSTANT go-to-end, then an immediate scroll-up, stops following", () => {
    const plan = planOf(4);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => handle.current?.scrollToEnd());
    el.scrollTop = 100;
    fireEvent.scroll(el);
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} follow="off" handleRef={handle} {...noopCtx} />);
    resize();
    expect(el.scrollTop).toBe(100);
  });

  it("LOW: a React ref object and a callback both satisfy the structural handle ref", () => {
    const obj = createRef<TranscriptHandle>();
    const seen: Array<TranscriptHandle | null> = [];
    render(<Transcript plan={planOf(2)} handleRef={obj} {...noopCtx} />);
    cleanup();
    render(<Transcript plan={planOf(2)} handleRef={(h) => seen.push(h)} {...noopCtx} />);
    expect(obj.current).not.toBeUndefined();
    expect(seen.some((h) => h !== null)).toBe(true);
  });
});

describe("cto LOW (guuey#2554): scrollToItem ends a gliding go-to-end", () => {
  it('under "tail": smooth go-to-end, then scrollToItem, then the reader reaches the end by hand, then growth → follows', () => {
    const plan = planOf(6);
    const handle = createRef<TranscriptHandle>();
    const { container, rerender } = render(<Transcript plan={plan} handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => handle.current?.scrollToEnd({ behavior: "smooth" }));
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key, { align: "top" });
    });
    el.scrollTop = content - PANEL;
    fireEvent.scroll(el);
    content = 3000;
    rerender(<Transcript plan={{ ...plan }} handleRef={handle} {...noopCtx} />);
    expect(el.scrollTop).toBe(3000 - PANEL);
  });
});


/**
 * A browser clamps `scrollTop` to `scrollHeight - clientHeight`; jsdom does not. This harness
 * models the clamp: `scrollHeight` is the items' height plus every other child of the scroller
 * (whatever room the transcript reserves below the column), and every write of `scrollTop`,
 * `scrollTo` included, lands at `min(requested, scrollHeight - clientHeight)`. A smooth
 * `scrollTo` moves nothing by itself: the test drives its frames.
 */
describe("scrollToItem near the end, under the browser's clamp (guuey#2554 follow-up)", () => {
  const top = new WeakMap<Element, number>();
  const reserved = (el: HTMLElement): number =>
    Array.from(el.children)
      .filter((c) => !c.classList.contains("guuey-chat-column"))
      .reduce((sum, c) => sum + (c instanceof HTMLElement ? Number.parseFloat(c.style.height) || 0 : 0), 0);
  const maxTop = (el: HTMLElement): number => el.scrollHeight - el.clientHeight;

  beforeEach(() => {
    const proto = HTMLElement.prototype;
    const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const scrollTopOwn = Object.getOwnPropertyDescriptor(proto, "scrollTop");
    const scrollTo = Object.getOwnPropertyDescriptor(proto, "scrollTo");
    const isScroller = (el: Element): boolean => el.classList.contains("guuey-chat-scroller");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? content + reserved(this) : 0;
      },
    });
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        // Read through the clamp too: room taken away below the view pulls the view up with it.
        const stored = top.get(this) ?? 0;
        return isScroller(this) ? Math.max(0, Math.min(stored, maxTop(this))) : stored;
      },
      set(this: HTMLElement, v: number) {
        top.set(this, isScroller(this) ? Math.max(0, Math.min(v, maxTop(this))) : v);
      },
    });
    Object.defineProperty(proto, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, opts: ScrollToOptions) {
        if (opts.behavior !== "smooth" && opts.top !== undefined) this.scrollTop = opts.top;
      },
    });
    restore.push(() => {
      if (scrollHeight !== undefined) Object.defineProperty(proto, "scrollHeight", scrollHeight);
      if (scrollTopOwn !== undefined) Object.defineProperty(proto, "scrollTop", scrollTopOwn);
      else Reflect.deleteProperty(proto, "scrollTop");
      if (scrollTo !== undefined) Object.defineProperty(proto, "scrollTo", scrollTo);
      else Reflect.deleteProperty(proto, "scrollTo");
    });
  });

  /** Five items (the last one the reader's new message) over 1500px of content in a 500px panel. */
  const setUp = (follow: "tail" | "off" = "off") => {
    const handle = createRef<TranscriptHandle>();
    const atEnd: boolean[] = [];
    const plan = planOf(5);
    content = 5 * ITEM_H;
    const view = (p: typeof plan) => (
      <Transcript plan={p} follow={follow} handleRef={handle} onAtEndChange={(v) => atEnd.push(v)} {...noopCtx} />
    );
    const { container, rerender } = render(view(plan));
    const el = scrollerOf(container);
    const lastKey = plan.items[plan.items.length - 1]!.key;
    const item = (): Element => {
      const column = el.querySelector(".guuey-chat-column");
      const last = column?.children[4];
      if (last === undefined) throw new Error("no last item");
      return last;
    };
    const grow = (to: number): void => {
      content = to;
      rerender(view({ ...plan }));
      resize();
    };
    /** The host renders another plan into the same transcript (a thread swap, a new conversation). */
    const swap = (next: typeof plan, height: number): void => {
      content = height;
      rerender(view(next));
      resize();
    };
    return { handle, atEnd, el, lastKey, item, grow, swap };
  };

  it("an item near the end lands at the requested offset: the transcript reserves exactly the shortfall below it", () => {
    const { handle, el, lastKey, item } = setUp();
    let ok = false;
    act(() => {
      ok = handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 }) ?? false;
    });
    expect(ok).toBe(true);
    // The item's top (1200) less the offset is 1160; without room the scroll bottoms out at 1000.
    expect(el.scrollTop).toBe(4 * ITEM_H - 40);
    expect(item().getBoundingClientRect().top).toBe(40);
    expect(reserved(el)).toBe(4 * ITEM_H - 40 - (content - PANEL));
  });

  it("the reserved room shrinks as the reply grows, never moving the view, and is gone once the reply fills it", () => {
    const { handle, atEnd, el, lastKey, grow } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    const placed = el.scrollTop;
    expect(reserved(el)).toBe(160);
    grow(1600);
    expect(reserved(el)).toBe(60);
    expect(el.scrollTop).toBe(placed);
    grow(1700);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(placed);
    grow(2400);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(placed);
    expect(atEnd[atEnd.length - 1]).toBe(false);
  });

  it("going to the end releases the room and follows the stream from the content's real end", () => {
    const { handle, el, lastKey, grow } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    expect(reserved(el)).toBe(160);
    act(() => handle.current?.scrollToEnd());
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(1500 - PANEL);
    grow(1800);
    expect(el.scrollTop).toBe(1800 - PANEL);
    expect(reserved(el)).toBe(0);
  });

  it("no room is reserved when the item can already reach its place", () => {
    const { handle, el } = setUp();
    const plan = planOf(5);
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key, { align: "top", offset: 20 });
    });
    expect(el.scrollTop).toBe(ITEM_H - 20);
    expect(reserved(el)).toBe(0);
  });

  it("the reader scrolling up past the room releases it without moving the view; the end is then the content's", () => {
    const { handle, el, lastKey } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    el.scrollTop = 400;
    fireEvent.scroll(el);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(400);
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(1500 - PANEL);
  });

  it('under "tail", the placement\'s own scroll event does not start following again', () => {
    const { handle, el, lastKey, grow } = setUp("tail");
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    // The browser reports the move: the view rests at the scroll's bottom, the reserved room in view.
    fireEvent.scroll(el);
    grow(2400);
    expect(el.scrollTop).toBe(4 * ITEM_H - 40);
  });

  it("a smooth placement keeps its room through the frames it emits on the way", () => {
    const { handle, el, lastKey } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40, behavior: "smooth" });
    });
    expect(reserved(el)).toBe(160);
    for (const frame of [300, 700, 1160]) {
      el.scrollTop = frame;
      fireEvent.scroll(el);
      expect(reserved(el)).toBe(160);
    }
    expect(el.scrollTop).toBe(1160);
  });

  it("a content reset (a new conversation in the same transcript) releases the room: the view comes back to the content", () => {
    const { handle, el, lastKey, swap } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    expect(el.scrollTop).toBe(1160);
    expect(reserved(el)).toBe(160);
    // The host swaps the thread: one short item, and the placed one no longer renders.
    swap(planOf(1), 300);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(0);
    expect(el.scrollTop).toBeLessThan(content);
  });

  it("content shrinking under a held room never grows the room past what the placement reserved", () => {
    const { handle, el, lastKey, grow } = setUp();
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    grow(1650);
    expect(reserved(el)).toBe(10);
    // A regenerated reply comes back shorter: the room stays bounded, the clamp pulls the view up.
    grow(1400);
    expect(reserved(el)).toBe(10);
    expect(el.scrollTop).toBe(1400 + 10 - PANEL);
  });

  it("the reader scrolling back to the top of content shorter than the panel releases the room", () => {
    const handle = createRef<TranscriptHandle>();
    const plan = planOf(2);
    content = 400;
    const { container } = render(<Transcript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    const el = scrollerOf(container);
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key, { align: "top" });
    });
    expect(el.scrollTop).toBe(ITEM_H);
    expect(reserved(el)).toBe(ITEM_H + PANEL - 400);
    fireEvent.scroll(el);
    el.scrollTop = 0;
    fireEvent.scroll(el);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(0);
  });

  it("an instant placement the host's CSS turns into a glide (scroll-behavior: smooth) keeps its room", () => {
    const { handle, el, lastKey } = setUp();
    // The scroller glides even for behavior "auto": scrollTo moves nothing by itself.
    el.scrollTo = () => {};
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    for (const frame of [200, 600, 1160]) {
      el.scrollTop = frame;
      fireEvent.scroll(el);
      expect(reserved(el)).toBe(160);
    }
    expect(el.scrollTop).toBe(1160);
  });

  it('a glide the panel cuts short (the panel grows mid-way) ends there: the reader\'s next move to the end re-pins under "tail"', () => {
    const { handle, el, lastKey, grow } = setUp("tail");
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40, behavior: "smooth" });
    });
    // Following had the view at the bottom (1000); the glide's first frame.
    el.scrollTop = 1080;
    fireEvent.scroll(el);
    // A keyboard closes: the panel grows to 700, and the room stays what the placement reserved.
    panel = 700;
    resize();
    expect(reserved(el)).toBe(160);
    // The browser's clamp ends the glide at the new bottom.
    el.scrollTop = 1160;
    expect(el.scrollTop).toBe(1500 + 160 - 700);
    fireEvent.scroll(el);
    grow(1560);
    // The reader scrolls to the end themselves: under "tail" that is following again.
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    grow(2400);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(2400 - 700);
  });

  it('under "tail", the reader coming back to the end by hand resumes following from the content\'s own end', () => {
    const { handle, el, lastKey, grow } = setUp("tail");
    act(() => {
      handle.current?.scrollToItem(lastKey, { align: "top", offset: 40 });
    });
    fireEvent.scroll(el);
    // The reader nudges up, then back down to the end (the room's bottom): following again.
    el.scrollTop = 1100;
    fireEvent.scroll(el);
    el.scrollTop = 99999;
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(1160);
    // The reply grows 50px, less than the room: following releases it and rests at the content's end.
    grow(1550);
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(1550 - PANEL);
  });
});

/**
 * The same clamp, with what a browser also does that the harness above leaves out: every column
 * child has its own height, and a change in height ABOVE the view moves `scrollTop` with it, so
 * what the reader sees stays put (scroll anchoring). The anchor is the first child not wholly
 * above the view, picked on every write; its move is applied by the next read of `scrollTop`, as a
 * browser applies it at the next layout. An anchor removed from the DOM moves nothing; the next
 * one is picked where the view is.
 */
describe("the reserved room is kept relative to its item, under the clamp and scroll anchoring (guuey#2554)", () => {
  /** The "show earlier" button's height; every message not in `heights` is ITEM_H tall. */
  const SHOW_H = 100;
  let heights = new Map<number, number>();
  const stored = new WeakMap<Element, number>();
  const anchors = new WeakMap<Element, { node: Element; offset: number }>();

  const isScroller = (el: Element): boolean => el.classList.contains("guuey-chat-scroller");
  const columnIn = (el: Element): Element | null => el.querySelector(".guuey-chat-column");
  const heightOf = (child: Element): number => {
    if (child.classList.contains("guuey-chat-show-earlier")) return SHOW_H;
    const m = /(?:question|answer) (\d+)/.exec(child.textContent ?? "");
    return m === null ? 0 : (heights.get(Number(m[1])) ?? ITEM_H);
  };
  const offsetOf = (child: Element): number => {
    let y = 0;
    for (let c = child.previousElementSibling; c !== null; c = c.previousElementSibling) y += heightOf(c);
    return y;
  };
  const contentOf = (el: Element): number =>
    Array.from(columnIn(el)?.children ?? []).reduce((sum, c) => sum + heightOf(c), 0);
  const reserved = (el: Element): number =>
    Array.from(el.children)
      .filter((c) => !c.classList.contains("guuey-chat-column"))
      .reduce((sum, c) => sum + (c instanceof HTMLElement ? Number.parseFloat(c.style.height) || 0 : 0), 0);
  const maxTop = (el: HTMLElement): number => Math.max(0, el.scrollHeight - el.clientHeight);
  const clampTop = (el: HTMLElement, v: number): number => Math.max(0, Math.min(v, maxTop(el)));
  const pickAnchor = (el: HTMLElement, top: number): void => {
    const node = Array.from(columnIn(el)?.children ?? []).find((c) => offsetOf(c) + heightOf(c) > top);
    if (node === undefined) anchors.delete(el);
    else anchors.set(el, { node, offset: offsetOf(node) });
  };

  beforeEach(() => {
    heights = new Map();
    const proto = HTMLElement.prototype;
    const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const scrollTopOwn = Object.getOwnPropertyDescriptor(proto, "scrollTop");
    const scrollTo = Object.getOwnPropertyDescriptor(proto, "scrollTo");
    const rect = Element.prototype.getBoundingClientRect;
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? contentOf(this) + reserved(this) : 0;
      },
    });
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get(this: HTMLElement) {
        const own = stored.get(this) ?? 0;
        if (!isScroller(this)) return own;
        const anchor = anchors.get(this);
        const kept = anchor !== undefined && anchor.node.isConnected;
        let v = own;
        if (kept) {
          const now = offsetOf(anchor.node);
          v += now - anchor.offset;
          anchors.set(this, { node: anchor.node, offset: now });
        }
        v = clampTop(this, v);
        stored.set(this, v);
        if (!kept) pickAnchor(this, v);
        return v;
      },
      set(this: HTMLElement, v: number) {
        if (!isScroller(this)) {
          stored.set(this, v);
          return;
        }
        const top = clampTop(this, v);
        stored.set(this, top);
        pickAnchor(this, top);
      },
    });
    Object.defineProperty(proto, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, opts: ScrollToOptions) {
        if (opts.behavior !== "smooth" && opts.top !== undefined) this.scrollTop = opts.top;
      },
    });
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (isScroller(this)) return new DOMRect(0, 0, 300, panel);
      const column = this.parentElement;
      const scroller = this.closest(".guuey-chat-scroller");
      if (column === null || !column.classList.contains("guuey-chat-column") || !(scroller instanceof HTMLElement)) {
        return new DOMRect(0, 0, 0, 0);
      }
      return new DOMRect(0, offsetOf(this) - scroller.scrollTop, 300, heightOf(this));
    };
    restore.push(() => {
      if (scrollHeight !== undefined) Object.defineProperty(proto, "scrollHeight", scrollHeight);
      if (scrollTopOwn !== undefined) Object.defineProperty(proto, "scrollTop", scrollTopOwn);
      else Reflect.deleteProperty(proto, "scrollTop");
      if (scrollTo !== undefined) Object.defineProperty(proto, "scrollTo", scrollTo);
      else Reflect.deleteProperty(proto, "scrollTo");
      Element.prototype.getBoundingClientRect = rect;
    });
  });

  /** `count` messages, the newest `tail` rendered, under follow="off". */
  const setUp = (count: number, tail: number) => {
    const handle = createRef<TranscriptHandle>();
    const view = (n: number) => (
      <Transcript plan={planOf(n)} follow="off" window={{ tail }} handleRef={handle} {...noopCtx} />
    );
    const { container, rerender } = render(view(count));
    const el = scrollerOf(container);
    /** The rendered element of message `i`. */
    const message = (i: number): Element => {
      const found = Array.from(columnIn(el)?.children ?? []).find((c) =>
        new RegExp(`(?:question|answer) ${i}$`).test(c.textContent ?? ""),
      );
      if (found === undefined) throw new Error(`message ${i} is not rendered`);
      return found;
    };
    const place = (i: number, offset: number): void => {
      const key = planOf(count).items[i]!.key;
      let ok = false;
      act(() => {
        ok = handle.current?.scrollToItem(key, { align: "top", offset }) ?? false;
      });
      expect(ok).toBe(true);
    };
    /** Message `n - 1` arrives (and, windowed, the oldest rendered one leaves). */
    const arrive = (n: number): void => {
      rerender(view(n));
      resize();
    };
    return { el, message, place, arrive };
  };

  it("an item above grows after the placement (an image loading): the placed item stays at its offset", () => {
    const { el, message, place } = setUp(5, 80);
    place(4, 40);
    expect(el.scrollTop).toBe(1160);
    expect(reserved(el)).toBe(160);
    // The oldest message's image loads: 100px more above the view; anchoring moves the view with it.
    heights.set(0, 400);
    resize();
    expect(el.scrollTop).toBe(1260);
    expect(message(4).getBoundingClientRect().top).toBe(40);
    expect(reserved(el)).toBe(160);
    // The reply then grows into the room as before, the view still where the host put it.
    heights.set(4, 400);
    resize();
    expect(reserved(el)).toBe(60);
    expect(el.scrollTop).toBe(1260);
    expect(message(4).getBoundingClientRect().top).toBe(40);
  });

  it("windowing drops an item above as the reply arrives: the room is exactly the shortfall left", () => {
    // Six messages, five rendered behind a "show earlier" button.
    const { el, message, place, arrive } = setUp(6, 5);
    place(5, 40);
    expect(el.scrollTop).toBe(SHOW_H + 4 * ITEM_H - 40);
    expect(reserved(el)).toBe(160);
    // A short reply arrives and the oldest rendered message leaves the window: 300px gone above.
    heights.set(6, 100);
    arrive(7);
    expect(message(5).getBoundingClientRect().top).toBe(40);
    // What placing it there still lacks: 960 + 500 - 1400 = 60, and no blank can be scrolled into.
    expect(reserved(el)).toBe(60);
    expect(maxTop(el)).toBe(el.scrollTop);
    // The reply grows to fill it: the room is gone.
    heights.set(6, 300);
    resize();
    expect(reserved(el)).toBe(0);
    expect(message(5).getBoundingClientRect().top).toBe(40);
  });

  it("content above shrinks as the reply grows: the room never exceeds the shortfall", () => {
    const { el, message, place } = setUp(5, 80);
    place(4, 40);
    expect(reserved(el)).toBe(160);
    // A card above collapses by 100 in the same frame the reply grows by 100: the content's height
    // is unchanged, but the placed item moved up with the view, and only 60px is still lacking.
    heights.set(0, 200);
    heights.set(4, 400);
    resize();
    expect(message(4).getBoundingClientRect().top).toBe(40);
    expect(reserved(el)).toBe(60);
    expect(maxTop(el)).toBe(el.scrollTop);
  });

  it("the placed item windowed out releases the room", () => {
    heights.set(1, 600);
    const { el, message, place, arrive } = setUp(3, 2);
    place(2, 40);
    expect(reserved(el)).toBe(160);
    // A short reply arrives: message 1 leaves the window and the room refits to the item's new place.
    heights.set(3, 100);
    arrive(4);
    expect(message(2).getBoundingClientRect().top).toBe(40);
    expect(reserved(el)).toBe(60);
    // The next one windows the placed message out: no item to hold, so no room.
    arrive(5);
    expect(() => message(2)).toThrow();
    expect(reserved(el)).toBe(0);
    expect(el.scrollTop).toBe(maxTop(el));
  });
});
