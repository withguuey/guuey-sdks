/**
 * guuey#2554 — the room a placement near the end reserves below the last item: the pure arithmetic
 * every transcript shares (the web `<Transcript>` reads the DOM into these numbers; a native
 * transcript reads its layout events). `react/transcript-scroll.test.tsx` runs it through the web
 * component end to end; this file pins each function on its own.
 */
import { describe, expect, it } from "vitest";
import {
  isRoomScrolledPast,
  isRoomSpent,
  itemPlaceTop,
  nextRoom,
  ratchetRoomPx,
  reserveRoom,
  roomShortfall,
  type TranscriptRoom,
} from "./transcript-scroll.js";

const held: TranscriptRoom = { key: "u:2", align: "top", offset: 40, px: 200 };

describe("itemPlaceTop: the scroll offset that puts the item where the host asked", () => {
  const item = { itemTop: 1000, itemHeight: 120, viewportHeight: 500 };

  it('"top" puts the item\'s top at the viewport\'s top, less the offset', () => {
    expect(itemPlaceTop(item, "top", 0)).toBe(1000);
    expect(itemPlaceTop(item, "top", 40)).toBe(960);
  });

  it('"end" puts the item\'s bottom at the viewport\'s bottom, the offset above it', () => {
    // 1000 + 120 - 500 = 620; the offset keeps 30px below the item.
    expect(itemPlaceTop(item, "end", 0)).toBe(620);
    expect(itemPlaceTop(item, "end", 30)).toBe(650);
  });

  it("never goes above the content's top", () => {
    expect(itemPlaceTop({ itemTop: 10, itemHeight: 50, viewportHeight: 500 }, "top", 40)).toBe(0);
    expect(itemPlaceTop({ itemTop: 10, itemHeight: 50, viewportHeight: 500 }, "end", 0)).toBe(0);
  });
});

describe("roomShortfall: what a target lacks under the clamp contentHeight - viewportHeight", () => {
  const clamp = { contentHeight: 2000, viewportHeight: 500 }; // the furthest scroll is 1500

  it("is 0 under the clamp and AT it", () => {
    expect(roomShortfall(1000, clamp)).toBe(0);
    expect(roomShortfall(1500, clamp)).toBe(0);
  });

  it("is the distance past the clamp over it", () => {
    expect(roomShortfall(1501, clamp)).toBe(1);
    expect(roomShortfall(1800, clamp)).toBe(300);
  });

  it("rounds a fractional shortfall UP to whole pixels, so the place is always reachable", () => {
    expect(roomShortfall(1500.25, clamp)).toBe(1);
    expect(roomShortfall(1799.5, clamp)).toBe(300);
  });
});

describe("reserveRoom: the room a placement holds, or none", () => {
  it("holds the place relative to its item with the shortfall as its px", () => {
    expect(reserveRoom("u:2", "end", 12, 300)).toEqual({ key: "u:2", align: "end", offset: 12, px: 300 });
  });

  it("is none when the place is reachable as it is", () => {
    expect(reserveRoom("u:2", "top", 0, 0)).toBeNull();
  });
});

describe("ratchetRoomPx: the room only ever shrinks", () => {
  it("shrinks by what grew into it", () => {
    expect(ratchetRoomPx(200, 150)).toBe(150);
    expect(ratchetRoomPx(200, 0)).toBe(0);
  });

  it("never grows, whatever the place now lacks", () => {
    expect(ratchetRoomPx(200, 200)).toBe(200);
    expect(ratchetRoomPx(200, 350)).toBe(200);
  });
});

describe("isRoomSpent: released at 0", () => {
  it("is spent at 0 and held above it", () => {
    expect(isRoomSpent(0)).toBe(true);
    expect(isRoomSpent(1)).toBe(false);
  });
});

describe("isRoomScrolledPast: releasing the room moves nothing in view", () => {
  // 2000 of content + 200 of room in a 500 viewport: the room is wholly below the view at <= 1500.
  const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 2200, viewportHeight: 500 });

  it("is past once the room is wholly below the view, and AT that edge", () => {
    expect(isRoomScrolledPast(200, at(1200))).toBe(true);
    expect(isRoomScrolledPast(200, at(1500))).toBe(true);
  });

  it("is not past while any of the room is in view", () => {
    expect(isRoomScrolledPast(200, at(1501))).toBe(false);
    expect(isRoomScrolledPast(200, at(1700))).toBe(false);
  });

  it("is past at the top when the content is shorter than the viewport", () => {
    // 300 of content + 400 of room: the content never scrolls on its own.
    expect(isRoomScrolledPast(400, { scrollTop: 0, scrollHeight: 700, viewportHeight: 500 })).toBe(true);
    expect(isRoomScrolledPast(400, { scrollTop: 1, scrollHeight: 700, viewportHeight: 500 })).toBe(false);
  });
});

describe("nextRoom: what each event does to the held room", () => {
  it("holds nothing when nothing is held", () => {
    expect(nextRoom(null, { kind: "refit", shortfall: 100 })).toBeNull();
    expect(nextRoom(null, { kind: "end" })).toBeNull();
  });

  it("a refit shrinks it to what the place still lacks, keeping the place", () => {
    expect(nextRoom(held, { kind: "refit", shortfall: 120 })).toEqual({ ...held, px: 120 });
  });

  it("a refit that changes nothing keeps the SAME room (nothing to resize)", () => {
    expect(nextRoom(held, { kind: "refit", shortfall: 200 })).toBe(held);
  });

  it("a refit never grows it: content shrinking keeps the room as it was", () => {
    expect(nextRoom(held, { kind: "refit", shortfall: 500 })).toBe(held);
  });

  it("a refit releases it at 0", () => {
    expect(nextRoom(held, { kind: "refit", shortfall: 0 })).toBeNull();
  });

  it("a refit releases it when no item with its key renders", () => {
    expect(nextRoom(held, { kind: "refit", shortfall: null })).toBeNull();
  });

  it("an end (go-to-end, or following resumed) releases it", () => {
    expect(nextRoom(held, { kind: "end" })).toBeNull();
  });

  it("a reader's scroll releases it once scrolled past, and keeps the SAME room before", () => {
    const scroll = (scrollTop: number) => ({ scrollTop, scrollHeight: 2200, viewportHeight: 500 });
    expect(nextRoom(held, { kind: "reader-scroll", scroll: scroll(1400) })).toBeNull();
    expect(nextRoom(held, { kind: "reader-scroll", scroll: scroll(1600) })).toBe(held);
  });
});
