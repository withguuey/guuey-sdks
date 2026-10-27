// @vitest-environment jsdom
/**
 * guuey#2850: under `follow="off"`, `scrollToItem` reserves the room a place near the end lacks.
 * The stand-in list here RENDERS its cells and footer and keeps a layout model: per-item heights,
 * the footer's status line, a host margin above the list. A mocked `View` answers `measureLayout`
 * from that model, synchronously as the New Architecture does (or never, as the old one answers
 * later), and `scrollToOffset` CLAMPS at `content - viewport`, as a native scroll view does, so a
 * place the content cannot reach stops short unless the room is there.
 */
import { act, cleanup, render } from "@testing-library/react";
import {
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  useContext,
  useImperativeHandle,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import type { DisplayItem, TranscriptInputs, TranscriptPlan } from "../types.js";

const PANEL = 500;
const ITEM = 100;

interface StandInProps {
  data: DisplayItem[];
  renderItem: (info: { item: DisplayItem; index: number }) => ReactNode;
  ListHeaderComponent?: ReactNode;
  ListFooterComponent?: ReactNode;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange?: (w: number, h: number) => void;
  onLayout?: (e: {
    nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
  }) => void;
  onScrollBeginDrag?: () => void;
}

interface StandInViewProps {
  children?: ReactNode;
  style?: { height?: number };
}

type Measured = (x: number, y: number, width: number, height: number) => void;
interface IndexParams {
  index: number;
  viewPosition: number;
  viewOffset: number;
  animated: boolean;
}
interface EndParams {
  animated: boolean;
}
/** The spacer's props, as a host reads them off the footer. */
interface SpacerProps {
  style: { height: number };
  pointerEvents: string;
  accessibilityElementsHidden: boolean;
  importantForAccessibility: string;
}
interface FooterProps {
  style?: object;
  children: [ReactNode, ReactElement<SpacerProps>];
}

const model = vi.hoisted(() => ({
  /** Per-item heights; unset items are ITEM high. */
  heights: new Map<string, number>(),
  /** The footer content above the spacer (a status line), px. */
  tail: 0,
  /** The list's top inside the transcript's outer view (a host margin), px. */
  listTop: 0,
  /** Keys the list does not render (virtualized out); their space stays in the content. */
  hidden: new Set<string>(),
  /** true: measureLayout answers before it returns (New Architecture); false: it never does here. */
  sync: true,
  /** A host `contentContainerStyle` bottom padding, after the spacer, px. */
  padBottom: 0,
  /** The spacer's rendered height. */
  spacerPx: 0,
  /** The list's offset after the clamp. */
  offset: 0,
  props: null as StandInProps | null,
  calls: {
    scrollToOffset: [] as Array<{ offset: number; animated: boolean }>,
    scrollToIndex: [] as IndexParams[],
    scrollToEnd: [] as EndParams[],
  },
}));

const heightOf = (key: string): number => model.heights.get(key) ?? ITEM;
const itemsOf = (): DisplayItem[] => model.props?.data ?? [];
/** Where the content ends without the room (content coordinates). */
const bareEnd = (): number =>
  itemsOf().reduce((sum, item) => sum + heightOf(item.key), 0) + model.tail;
const contentEnd = (): number => bareEnd() + model.spacerPx + model.padBottom;
/** An item's top, in content coordinates. */
const yOf = (key: string): number => {
  let y = 0;
  for (const item of itemsOf()) {
    if (item.key === key) return y;
    y += heightOf(item.key);
  }
  throw new Error(`no item ${key}`);
};

vi.mock("react-native", () => {
  type Node = { kind: "item"; key: string } | { kind: "footer" } | null;
  const NodeContext = createContext<Node>(null);
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  const View = forwardRef<{ measureLayout: (rel: object, ok: Measured) => void }, StandInViewProps>(
    function View({ children, style }, ref) {
      const node = useContext(NodeContext);
      // The spacer is the footer's view with a height.
      if (node?.kind === "footer" && typeof style?.height === "number")
        model.spacerPx = style.height;
      useImperativeHandle(ref, () => ({
        measureLayout(_rel: object, ok: Measured) {
          if (!model.sync) return;
          if (node === null) return ok(0, 0, 300, PANEL);
          if (node.kind === "item")
            return ok(0, model.listTop + yOf(node.key), 300, heightOf(node.key));
          ok(0, model.listTop + bareEnd(), 300, model.spacerPx);
        },
      }));
      return createElement("div", null, children);
    }
  );
  const FlatList = forwardRef<object, StandInProps>(function FlatList(props, ref) {
    model.props = props;
    useImperativeHandle(ref, () => ({
      scrollToOffset(params: { offset: number; animated: boolean }) {
        model.calls.scrollToOffset.push(params);
        // A native scroll view clamps at the end of its content.
        model.offset = Math.max(0, Math.min(params.offset, contentEnd() - PANEL));
      },
      scrollToIndex(params: IndexParams) {
        model.calls.scrollToIndex.push(params);
      },
      scrollToEnd(params: EndParams) {
        model.calls.scrollToEnd.push(params);
      },
    }));
    return createElement(
      "div",
      null,
      props.ListHeaderComponent ?? null,
      props.data.map((item, index) =>
        model.hidden.has(item.key)
          ? null
          : createElement(
              NodeContext.Provider,
              { key: item.key, value: { kind: "item", key: item.key } },
              props.renderItem({ item, index })
            )
      ),
      createElement(
        NodeContext.Provider,
        { value: { kind: "footer" } },
        props.ListFooterComponent ?? null
      )
    );
  });
  return {
    View,
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

function planOf(messageCount: number): TranscriptPlan {
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
        : ({ role: "assistant", text: `answer ${i}` } as const)
    ),
  };
  return planTranscript(inputs, calmPolicy());
}

const noopCtx = {
  onToggle: () => {},
  resolvedMounts: new Map<string, never>(),
  onViewPhase: () => {},
};

beforeEach(() => {
  model.heights.clear();
  model.tail = 0;
  model.listTop = 0;
  model.padBottom = 0;
  model.hidden.clear();
  model.sync = true;
  model.spacerPx = 0;
  model.offset = 0;
  model.props = null;
  model.calls = { scrollToOffset: [], scrollToIndex: [], scrollToEnd: [] };
});

afterEach(() => {
  cleanup();
});

const props = (): StandInProps => {
  if (model.props === null) throw new Error("no list rendered");
  return model.props;
};
/** The list lays out (its panel) and reports the content the model holds now. */
const layout = (panel = PANEL): void =>
  act(() => {
    props().onLayout?.({
      nativeEvent: { layout: { x: 0, y: model.listTop, width: 300, height: panel } },
    });
    props().onContentSizeChange?.(300, contentEnd());
  });
/** The list reports the content the model holds now (after a render or a resize). */
const settle = (): void =>
  act(() => {
    props().onContentSizeChange?.(300, contentEnd());
  });
/**
 * A scroll event at `offset`; `drag` marks it as the reader's own move. `reported` is the content
 * size the event carries (by default the model's now; a late event carries an older one).
 */
const scroll = (offset: number, drag = false, reported = contentEnd()): void =>
  act(() => {
    if (drag) props().onScrollBeginDrag?.();
    model.offset = offset;
    const nativeEvent = {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 300, height: reported },
      layoutMeasurement: { width: 300, height: PANEL },
    };
    props().onScroll?.({ nativeEvent } as NativeSyntheticEvent<NativeScrollEvent>);
  });
/** What a place at the top of `key`, `offset` below the panel's top, lacks below now. */
const lackedAtTop = (key: string, offset: number): number =>
  Math.max(0, Math.ceil(Math.max(0, yOf(key) - offset) + PANEL - bareEnd()));

/** Render under "off" with a handle; the plan re-renders through `show`. */
function mountOff(plan: TranscriptPlan) {
  const handle = createRef<NativeTranscriptHandle>();
  const view = (p: TranscriptPlan) => (
    <NativeTranscript plan={p} follow="off" handleRef={handle} {...noopCtx} />
  );
  const { rerender } = render(view(plan));
  layout();
  return {
    handle,
    show: (p: TranscriptPlan) => {
      rerender(view(p));
      settle();
    },
    place: (
      key: string,
      opts: Parameters<NativeTranscriptHandle["scrollToItem"]>[1] = {}
    ): boolean => {
      let ok = false;
      act(() => {
        ok = handle.current?.scrollToItem(key, opts) ?? false;
      });
      return ok;
    },
  };
}

const lastKey = (plan: TranscriptPlan): string => plan.items[plan.items.length - 1]!.key;

describe("the clamp the room answers", () => {
  it("with no room, a place past the content's end stops short (the stand-in clamps like a native list)", () => {
    const plan = planOf(5);
    const { handle } = mountOff(plan);
    const target = yOf(lastKey(plan)) - 40;
    // Ask the list directly, as a transcript without the room would.
    act(() => handle.current?.element?.scrollToOffset({ offset: target, animated: false }));
    expect(model.offset).toBe(contentEnd() - PANEL);
    expect(model.offset).toBeLessThan(target);
  });
});

describe('scrollToItem under follow="off": the room below the last item', () => {
  it("lands the last item exactly at its offset, scrolling only once its room is laid out", () => {
    const plan = planOf(5);
    const { place } = mountOff(plan);
    const key = lastKey(plan);
    const target = yOf(key) - 40;
    const lacked = lackedAtTop(key, 40);
    expect(lacked).toBeGreaterThan(0);

    expect(place(key, { align: "top", offset: 40 })).toBe(true);
    // The room renders first; the scroll waits for the content to cover the place.
    expect(model.spacerPx).toBe(lacked);
    expect(model.calls.scrollToOffset).toEqual([]);
    expect(model.calls.scrollToIndex).toEqual([]);

    settle();
    expect(model.calls.scrollToOffset).toEqual([{ offset: target, animated: false }]);
    expect(model.offset).toBe(target);
  });

  it("shrinks as the reply grows, never moves the view, and leaves no blank once the reply fills it", () => {
    const question = planOf(5);
    const { place, show } = mountOff(question);
    const key = lastKey(question);
    place(key, { align: "top", offset: 40 });
    settle();
    const target = yOf(key) - 40;

    const answered = planOf(6);
    const reply = lastKey(answered);
    const seen: number[] = [];
    for (const height of [50, 150, 260]) {
      model.heights.set(reply, height);
      show({ ...answered });
      seen.push(model.spacerPx);
      expect(model.spacerPx).toBe(lackedAtTop(key, 40));
    }
    expect(seen[0]).toBeGreaterThan(seen[1]!);
    expect(seen[1]).toBeGreaterThan(0);
    // The reply outgrew the room: none is left, and the place is still reachable from the content alone.
    model.heights.set(reply, 600);
    show({ ...answered });
    expect(model.spacerPx).toBe(0);
    expect(contentEnd()).toBe(bareEnd());
    expect(bareEnd() - PANEL).toBeGreaterThanOrEqual(target);
    // One scroll: the placement's own.
    expect(model.calls.scrollToOffset).toHaveLength(1);
    expect(model.calls.scrollToEnd).toEqual([]);
  });

  it("content above the item growing keeps the room exact: the place moves with its item", () => {
    const plan = planOf(5);
    const { place, show } = mountOff(plan);
    const key = lastKey(plan);
    place(key, { align: "top", offset: 40 });
    settle();
    const held = model.spacerPx;
    model.heights.set(plan.items[1]!.key, ITEM + 80);
    show({ ...plan });
    expect(model.spacerPx).toBe(held);
    expect(lackedAtTop(key, 40)).toBe(held);
  });

  it("content above shrinking while the reply grows never over-reserves", () => {
    const question = planOf(5);
    const { place, show } = mountOff(question);
    const key = lastKey(question);
    place(key, { align: "top", offset: 40 });
    settle();
    const answered = planOf(6);
    model.heights.set(lastKey(answered), 50);
    show({ ...answered });
    const before = model.spacerPx;
    model.heights.set(question.items[1]!.key, ITEM - 60);
    model.heights.set(lastKey(answered), 150);
    show({ ...answered });
    expect(model.spacerPx).toBe(Math.min(before, lackedAtTop(key, 40)));
    expect(model.spacerPx).toBeLessThan(before);
  });

  it("the panel growing never grows the room back (it only shrinks)", () => {
    const plan = planOf(5);
    const { place } = mountOff(plan);
    place(lastKey(plan), { align: "top", offset: 40 });
    settle();
    const held = model.spacerPx;
    layout(PANEL + 120);
    expect(model.spacerPx).toBe(held);
  });

  it("an item the content already reaches scrolls at once, with no room", () => {
    const plan = planOf(8);
    const { place } = mountOff(plan);
    const key = plan.items[1]!.key;
    expect(place(key, { align: "top", offset: 20 })).toBe(true);
    expect(model.spacerPx).toBe(0);
    expect(model.calls.scrollToOffset).toEqual([{ offset: yOf(key) - 20, animated: false }]);
  });

  it('align "end" keeps `offset` below the item, and a smooth placement animates', () => {
    const plan = planOf(8);
    const { place } = mountOff(plan);
    const key = plan.items[4]!.key;
    place(key, { align: "end", offset: 8, behavior: "smooth" });
    expect(model.calls.scrollToOffset).toEqual([
      { offset: yOf(key) + heightOf(key) - PANEL + 8, animated: true },
    ]);
  });

  it("offsets are the list's own when a host margin puts it lower in the transcript", () => {
    model.listTop = 30;
    const plan = planOf(5);
    const { place } = mountOff(plan);
    const key = lastKey(plan);
    place(key, { align: "top", offset: 40 });
    expect(model.spacerPx).toBe(lackedAtTop(key, 40));
    settle();
    expect(model.calls.scrollToOffset).toEqual([{ offset: yOf(key) - 40, animated: false }]);
  });
});

describe("a host's bottom padding (documented)", () => {
  it("sits after the room and is counted on top of it: the place lands exactly, and the reader can drag P past it", () => {
    model.padBottom = 24;
    const plan = planOf(5);
    const { place } = mountOff(plan);
    const key = lastKey(plan);
    const target = yOf(key) - 40;
    place(key, { align: "top", offset: 40 });
    // The room is what the place lacks without the padding: it over-reserves by exactly P.
    expect(model.spacerPx).toBe(lackedAtTop(key, 40));
    settle();
    expect(model.offset).toBe(target);
    expect(contentEnd() - PANEL - target).toBe(24);
  });
});

describe("the room is released", () => {
  const placed = () => {
    const plan = planOf(5);
    const mounted = mountOff(plan);
    mounted.place(lastKey(plan), { align: "top", offset: 40 });
    settle();
    expect(model.spacerPx).toBeGreaterThan(0);
    return { plan, ...mounted };
  };

  it("when the placed item leaves the plan", () => {
    const { show } = placed();
    show(planOf(3));
    expect(model.spacerPx).toBe(0);
  });

  it("when the placed item no longer renders (windowed out)", () => {
    const { plan, show } = placed();
    model.hidden.add(lastKey(plan));
    show({ ...plan });
    expect(model.spacerPx).toBe(0);
  });

  it("on scrollToEnd", () => {
    const { handle } = placed();
    act(() => handle.current?.scrollToEnd());
    expect(model.spacerPx).toBe(0);
    expect(model.calls.scrollToEnd).toEqual([{ animated: false }]);
  });

  it("when the reader drags up past it, but not on a drag that still shows it", () => {
    placed();
    const room = model.spacerPx;
    scroll(contentEnd() - PANEL - room + 10, true);
    expect(model.spacerPx).toBe(room);
    scroll(contentEnd() - PANEL - room, true);
    expect(model.spacerPx).toBe(0);
  });

  it("by the content's measured end, not a late event's content size that predates the spacer", () => {
    // Content taller than the panel, so "above the room" is a real offset, not the content's top.
    const plan = planOf(7);
    const { place } = mountOff(plan);
    place(lastKey(plan), { align: "top", offset: 40 });
    expect(model.spacerPx).toBeGreaterThan(0);
    expect(bareEnd() - PANEL).toBeGreaterThan(0);
    // The reader is above the room (releasing it moves nothing in view), and the event they drag
    // with still reports the content before the spacer grew.
    scroll(bareEnd() - PANEL, true, bareEnd());
    expect(model.spacerPx).toBe(0);
  });

  it("not by the placement's own scroll events", () => {
    placed();
    const room = model.spacerPx;
    scroll(0);
    expect(model.spacerPx).toBe(room);
  });
});

describe("what every host gets", () => {
  const footerOf = (): ReactElement<FooterProps> => {
    const footer = props().ListFooterComponent;
    if (!isValidElement<FooterProps>(footer)) throw new Error("no footer element");
    return footer;
  };

  it('at rest under "off" with no status, the footer is only a 0-high spacer, hidden from assistive tech on both platforms', () => {
    mountOff(planOf(4));
    const footer = footerOf();
    expect(footer.props.style).toBeUndefined();
    const [status, spacer] = footer.props.children;
    expect(status).toBeNull();
    expect(spacer.props).toMatchObject({
      style: { height: 0 },
      pointerEvents: "none",
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants",
    });
    expect(Object.keys(spacer.props.style)).toEqual(["height"]);
  });

  it('under "tail" there is no footer, and placement is the inverted index as before', () => {
    const plan = planOf(6);
    const handle = createRef<NativeTranscriptHandle>();
    render(<NativeTranscript plan={plan} handleRef={handle} {...noopCtx} />);
    layout();
    expect(props().ListFooterComponent).toBeUndefined();
    act(() => {
      handle.current?.scrollToItem(plan.items[1]!.key, { align: "top", offset: 40 });
    });
    expect(model.calls.scrollToIndex).toEqual([
      { index: 4, viewPosition: 1, viewOffset: -40, animated: false },
    ]);
    expect(model.calls.scrollToOffset).toEqual([]);
    expect(model.spacerPx).toBe(0);
  });

  it("without a synchronous measure (the old architecture), placement is scrollToIndex, with no room", () => {
    model.sync = false;
    const plan = planOf(5);
    const { place } = mountOff(plan);
    expect(place(lastKey(plan), { align: "top", offset: 40 })).toBe(true);
    expect(model.calls.scrollToIndex).toEqual([
      { index: plan.items.length - 1, viewPosition: 0, viewOffset: 40, animated: false },
    ]);
    expect(model.calls.scrollToOffset).toEqual([]);
    expect(model.spacerPx).toBe(0);
    settle();
    expect(model.calls.scrollToOffset).toEqual([]);
  });
});
