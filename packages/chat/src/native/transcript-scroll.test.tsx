// @vitest-environment jsdom
/**
 * The host's scroll control on <NativeTranscript>, the same API the web <Transcript> takes: the
 * `follow` policy, the handle (`scrollToItem`, `scrollToEnd`, `element`), `onAtEndChange` and
 * `jumpToLatest`. The FlatList is a stand-in that records its props and its scroll calls; a test
 * drives the geometry through the callbacks a real list fires (`onScroll`,
 * `onContentSizeChange`, `onLayout`, `onScrollBeginDrag`).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, createRef, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { DisplayItem, TranscriptInputs } from "../types.js";

interface ListCalls {
  scrollToOffset: ReturnType<typeof vi.fn>;
  scrollToEnd: ReturnType<typeof vi.fn>;
  scrollToIndex: ReturnType<typeof vi.fn>;
}

interface ListStandInProps {
  data: DisplayItem[];
  inverted?: boolean;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange?: (w: number, h: number) => void;
  onLayout?: (e: { nativeEvent: { layout: { height: number } } }) => void;
  onScrollBeginDrag?: () => void;
  onScrollToIndexFailed?: (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => void;
}

const list = vi.hoisted(() => ({
  props: null as ListStandInProps | null,
  api: null as (ListCalls & { measuredThrough: number }) | null,
}));

vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  const FlatList = forwardRef<ListCalls, ListStandInProps>(function FlatList(props, ref) {
    list.props = props;
    useImperativeHandle(ref, () => {
      if (list.api === null) throw new Error("no list api");
      return list.api;
    });
    return null;
  });
  return {
    View: passthrough("div"),
    Text: passthrough("span"),
    ScrollView: passthrough("div"),
    Image: passthrough("img"),
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
    FlatList,
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => {} }),
    },
    Linking: { openURL: () => Promise.resolve() },
  };
});

const { NativeTranscript } = await import("./transcript.js");
type NativeTranscriptHandle = import("./transcript.js").NativeTranscriptHandle;
const { calmPolicy } = await import("../policy.js");
const { planTranscript } = await import("../plan.js");

const PANEL = 500;

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

let calls: ListCalls & { measuredThrough: number };

beforeEach(() => {
  calls = {
    scrollToOffset: vi.fn(),
    scrollToEnd: vi.fn(),
    // A real list declines (synchronously) an index past its measured cells.
    scrollToIndex: vi.fn((params: { index: number }) => {
      if (params.index <= calls.measuredThrough) return;
      list.props?.onScrollToIndexFailed?.({
        index: params.index,
        highestMeasuredFrameIndex: calls.measuredThrough,
        averageItemLength: 100,
      });
    }),
    measuredThrough: 100,
  };
  list.api = calls;
  list.props = null;
});

afterEach(() => {
  cleanup();
});

const props = (): ListStandInProps => {
  if (list.props === null) throw new Error("no list rendered");
  return list.props;
};
const scrollCallCount = (): number =>
  calls.scrollToOffset.mock.calls.length + calls.scrollToEnd.mock.calls.length + calls.scrollToIndex.mock.calls.length;

/** A scroll event at `offset` over `content`; `drag` marks it as the reader's own move. */
const scroll = (offset: number, content: number, drag = false): void =>
  act(() => {
    if (drag) props().onScrollBeginDrag?.();
    const nativeEvent = {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 300, height: content },
      layoutMeasurement: { width: 300, height: PANEL },
    };
    props().onScroll?.({ nativeEvent } as NativeSyntheticEvent<NativeScrollEvent>);
  });
const grow = (content: number): void =>
  act(() => {
    props().onContentSizeChange?.(300, content);
  });
const layout = (content: number): void =>
  act(() => {
    props().onLayout?.({ nativeEvent: { layout: { height: PANEL } } });
    props().onContentSizeChange?.(300, content);
  });

describe("no scroll props: the inverted list as before", () => {
  it("is inverted over the reversed plan, draws the status as its header, and never scrolls on growth", () => {
    const plan = planOf(4);
    const { rerender } = render(<NativeTranscript plan={plan} {...noopCtx} />);
    expect(props().inverted).toBe(true);
    expect(props().data.map((i) => i.key)).toEqual([...plan.items].reverse().map((i) => i.key));
    expect(props().ListFooterComponent).toBeUndefined();
    layout(2000);
    scroll(300, 2000, true);
    for (const content of [2400, 3100]) {
      rerender(<NativeTranscript plan={{ ...plan }} {...noopCtx} />);
      grow(content);
    }
    expect(scrollCallCount()).toBe(0);
  });

  it("shows the jump chip past 160px up, and the chip goes back to offset 0", () => {
    render(<NativeTranscript plan={planOf(4)} {...noopCtx} />);
    scroll(100, 2000, true);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    scroll(200, 2000, true);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(calls.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});

describe('follow="off"', () => {
  it("is a top-down list over the plan in order, with the status as its footer", () => {
    const plan = planOf(4);
    render(<NativeTranscript plan={plan} follow="off" {...noopCtx} />);
    expect(props().inverted).toBe(false);
    expect(props().data.map((i) => i.key)).toEqual(plan.items.map((i) => i.key));
    expect(props().ListHeaderComponent).toBeUndefined();
  });

  it("a streaming turn never moves the list: no scroll call through every render and resize", () => {
    const plan = planOf(4);
    const { rerender } = render(<NativeTranscript plan={plan} follow="off" {...noopCtx} />);
    layout(2000);
    scroll(120, 2000, true);
    for (const content of [2400, 3100, 4000]) {
      rerender(<NativeTranscript plan={{ ...plan }} follow="off" {...noopCtx} />);
      grow(content);
    }
    expect(scrollCallCount()).toBe(0);
  });

  it("reaching the end by hand does not start following", () => {
    const plan = planOf(4);
    const { rerender } = render(<NativeTranscript plan={plan} follow="off" {...noopCtx} />);
    layout(2000);
    scroll(2000 - PANEL, 2000, true);
    rerender(<NativeTranscript plan={{ ...plan }} follow="off" {...noopCtx} />);
    grow(3000);
    expect(scrollCallCount()).toBe(0);
  });

  it("scrollToEnd goes to the end and follows from there, until the reader drags away", () => {
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={planOf(4)} follow="off" handleRef={handle} {...noopCtx} />);
    layout(2000);
    act(() => handle.current?.scrollToEnd());
    expect(calls.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
    // Our own follow's scroll event, at the end, keeps following.
    scroll(2000 - PANEL, 2000);
    grow(3000);
    expect(calls.scrollToEnd).toHaveBeenCalledTimes(2);
    // A non-drag frame away from the end (our own glide) does not stop it either.
    scroll(1200, 3000);
    grow(3200);
    expect(calls.scrollToEnd).toHaveBeenCalledTimes(3);
    scroll(100, 3200, true);
    grow(3600);
    expect(calls.scrollToEnd).toHaveBeenCalledTimes(3);
  });

  it("a smooth scrollToEnd animates; the chip's go-to-end follows too", () => {
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={planOf(4)} follow="off" handleRef={handle} {...noopCtx} />);
    layout(2000);
    act(() => handle.current?.scrollToEnd({ behavior: "smooth" }));
    expect(calls.scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
    scroll(0, 2000, true);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(calls.scrollToEnd).toHaveBeenLastCalledWith({ animated: true });
    grow(2600);
    expect(calls.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
  });
});

describe("scrollToItem", () => {
  it("answers false, without scrolling, for an unknown key", () => {
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={planOf(4)} follow="off" handleRef={handle} {...noopCtx} />);
    let ok = true;
    act(() => {
      ok = handle.current?.scrollToItem("no-such-key") ?? true;
    });
    expect(ok).toBe(false);
    expect(scrollCallCount()).toBe(0);
  });

  it("answers false, guessing no place, for an item past the list's measured cells", () => {
    const plan = planOf(6);
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    calls.measuredThrough = 2;
    let ok = true;
    act(() => {
      ok = handle.current?.scrollToItem(plan.items[4]!.key) ?? true;
    });
    expect(ok).toBe(false);
    // The list was asked, declined, and nothing else moved it.
    expect(calls.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(calls.scrollToOffset).not.toHaveBeenCalled();
    expect(calls.scrollToEnd).not.toHaveBeenCalled();
    act(() => {
      ok = handle.current?.scrollToItem(plan.items[2]!.key) ?? false;
    });
    expect(ok).toBe(true);
  });

  it('under "off": align top keeps `offset` above the item; align end keeps it below; smooth animates', () => {
    const plan = planOf(6);
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    let ok = false;
    act(() => {
      ok = handle.current?.scrollToItem(plan.items[2]!.key, { align: "top", offset: 20 }) ?? false;
    });
    expect(ok).toBe(true);
    expect(calls.scrollToIndex).toHaveBeenLastCalledWith({ index: 2, viewPosition: 0, viewOffset: 20, animated: false });
    act(() => {
      handle.current?.scrollToItem(plan.items[3]!.key, { align: "end", offset: 8, behavior: "smooth" });
    });
    expect(calls.scrollToIndex).toHaveBeenLastCalledWith({ index: 3, viewPosition: 1, viewOffset: -8, animated: true });
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key);
    });
    expect(calls.scrollToIndex).toHaveBeenLastCalledWith({ index: 1, viewPosition: 0, viewOffset: 0, animated: false });
  });

  it('under "tail": the index is the inverted list\'s, and the alignment flips with the inversion', () => {
    const plan = planOf(6);
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={plan} handleRef={handle} {...noopCtx} />);
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key, { align: "top", offset: 40 });
    });
    expect(calls.scrollToIndex).toHaveBeenLastCalledWith({ index: 4, viewPosition: 1, viewOffset: -40, animated: false });
    act(() => {
      handle.current?.scrollToItem(plan.items[5]!.key, { align: "end" });
    });
    expect(calls.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, viewPosition: 0, viewOffset: 0, animated: false });
  });

  it("stops following: growth after it does not pull the list to the end", () => {
    const plan = planOf(6);
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={plan} follow="off" handleRef={handle} {...noopCtx} />);
    layout(2000);
    act(() => handle.current?.scrollToEnd());
    act(() => {
      handle.current?.scrollToItem(plan.items[2]!.key);
    });
    grow(3000);
    expect(calls.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("the handle exposes the list, and stays the same object across renders", () => {
    const seen: Array<NativeTranscriptHandle | null> = [];
    const { rerender } = render(<NativeTranscript plan={planOf(2)} handleRef={(h) => seen.push(h)} {...noopCtx} />);
    rerender(<NativeTranscript plan={planOf(3)} handleRef={(h) => seen.push(h)} {...noopCtx} />);
    const handles = seen.filter((h) => h !== null);
    expect(handles.length).toBeGreaterThan(0);
    expect(handles[0]?.element).toBe(calls);
  });
});

describe("onAtEndChange and jumpToLatest", () => {
  it('fires as the tail enters and leaves the viewport under follow="off", once per change', () => {
    const seen: boolean[] = [];
    render(<NativeTranscript plan={planOf(4)} follow="off" onAtEndChange={(v) => seen.push(v)} {...noopCtx} />);
    // Nothing is known until the list is measured.
    expect(seen).toEqual([]);
    layout(2000);
    expect(seen).toEqual([false]);
    scroll(2000 - PANEL, 2000, true);
    scroll(2000 - PANEL, 2000, true);
    expect(seen).toEqual([false, true]);
    // The answer grows past the fold: the tail leaves the viewport with no scroll event.
    grow(3000);
    expect(seen).toEqual([false, true, false]);
  });

  it('fires under the default "tail" policy too: at the end on mount, then away', () => {
    const seen: boolean[] = [];
    render(<NativeTranscript plan={planOf(4)} onAtEndChange={(v) => seen.push(v)} {...noopCtx} />);
    expect(seen).toEqual([true]);
    scroll(30, 2000, true);
    expect(seen).toEqual([true]);
    scroll(200, 2000, true);
    expect(seen).toEqual([true, false]);
  });

  it("jumpToLatest={false} hides the built-in chip; the default shows it", () => {
    const { rerender } = render(<NativeTranscript plan={planOf(4)} jumpToLatest={false} {...noopCtx} />);
    scroll(400, 2000, true);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    rerender(<NativeTranscript plan={planOf(4)} {...noopCtx} />);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });
});

describe("a runtime policy change", () => {
  it('to "off" turns the list top-down and keeps the viewport where it was (its distance from the end)', () => {
    const plan = planOf(4);
    const { rerender } = render(<NativeTranscript plan={plan} {...noopCtx} />);
    layout(2000);
    scroll(100, 2000, true);
    rerender(<NativeTranscript plan={plan} follow="off" {...noopCtx} />);
    expect(props().inverted).toBe(false);
    expect(calls.scrollToOffset).toHaveBeenLastCalledWith({ offset: 2000 - PANEL - 100, animated: false });
    // And following has stopped.
    grow(2600);
    expect(calls.scrollToEnd).not.toHaveBeenCalled();
  });

  it('back to "tail" inverts again from the same distance', () => {
    const plan = planOf(4);
    const { rerender } = render(<NativeTranscript plan={plan} follow="off" {...noopCtx} />);
    layout(2000);
    scroll(1300, 2000, true);
    rerender(<NativeTranscript plan={plan} {...noopCtx} />);
    expect(props().inverted).toBe(true);
    expect(calls.scrollToOffset).toHaveBeenLastCalledWith({ offset: 200, animated: false });
  });
});

describe("the recipe: off, place the question at the top, read the reply as it streams", () => {
  it("places the new user item once, then the stream never moves the list until the host's own ↓", () => {
    const handle = createRef<NativeTranscriptHandle>();
    const atEnd: boolean[] = [];
    const view = (p: ReturnType<typeof planOf>) => (
      <NativeTranscript
        plan={p}
        follow="off"
        jumpToLatest={false}
        onAtEndChange={(v) => atEnd.push(v)}
        handleRef={handle}
        {...noopCtx}
      />
    );
    const { rerender } = render(view(planOf(4)));
    layout(2000);
    const plan = planOf(5);
    rerender(view(plan));
    act(() => {
      handle.current?.scrollToItem(plan.items[plan.items.length - 1]!.key, { align: "top", offset: 40 });
    });
    expect(calls.scrollToIndex).toHaveBeenCalledTimes(1);
    scroll(1160, 2000);
    for (const content of [2600, 3200, 4000]) {
      rerender(view(planOf(6)));
      grow(content);
    }
    expect(calls.scrollToEnd).not.toHaveBeenCalled();
    expect(calls.scrollToOffset).not.toHaveBeenCalled();
    expect(atEnd[atEnd.length - 1]).toBe(false);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    act(() => handle.current?.scrollToEnd());
    grow(4600);
    expect(calls.scrollToEnd).toHaveBeenLastCalledWith({ animated: false });
    expect(calls.scrollToEnd).toHaveBeenCalledTimes(2);
  });
});
