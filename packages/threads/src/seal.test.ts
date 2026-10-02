import { describe, expect, it } from "vitest";
import { InMemoryThreadPersistence } from "./in-memory.js";
import type { ThreadRow } from "./rows.js";
import { hasSealedPart, isSeqSealed, previewDigest, readableThreadPreview, readSealState } from "./seal.js";
import { ThreadStore } from "./store.js";

describe("readSealState", () => {
  it("reads an absent record as a legacy, wholly readable thread", () => {
    expect(readSealState(undefined)).toEqual({ kind: "none" });
    expect(readSealState(null)).toEqual({ kind: "none" });
  });

  it("reads a well-formed list, open and closed intervals alike", () => {
    expect(readSealState([{ fromSeq: 1, toSeq: 4 }, { fromSeq: 9 }])).toEqual({
      kind: "intervals",
      intervals: [{ fromSeq: 1, toSeq: 4 }, { fromSeq: 9 }],
    });
    expect(readSealState([])).toEqual({ kind: "intervals", intervals: [] });
  });

  it.each([
    ["a non-array", { fromSeq: 1 }],
    ["a string", "1-4"],
    ["a missing fromSeq", [{ toSeq: 3 }]],
    ["a zero fromSeq", [{ fromSeq: 0 }]],
    ["a fractional seq", [{ fromSeq: 1.5 }]],
    ["a toSeq before fromSeq", [{ fromSeq: 5, toSeq: 4 }]],
    ["a string toSeq", [{ fromSeq: 1, toSeq: "4" }]],
    ["one bad entry among good ones", [{ fromSeq: 1, toSeq: 2 }, null]],
  ])("fails closed on %s", (_label, stored) => {
    const state = readSealState(stored);
    expect(state).toEqual({ kind: "unreadable" });
    expect(isSeqSealed(state, 1)).toBe(true);
    expect(isSeqSealed(state, 1000)).toBe(true);
    expect(hasSealedPart(state)).toBe(true);
  });
});

describe("isSeqSealed", () => {
  const state = readSealState([{ fromSeq: 3, toSeq: 5 }, { fromSeq: 10 }]);

  it("covers both ends of a closed interval, and nothing outside it", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((seq) => isSeqSealed(state, seq))).toEqual([
      false, false, true, true, true, false, false,
    ]);
  });

  it("covers every seq from an open interval's start onward", () => {
    expect(isSeqSealed(state, 10)).toBe(true);
    expect(isSeqSealed(state, 10_000)).toBe(true);
  });

  it("seals nothing on a legacy thread or an empty list", () => {
    expect(isSeqSealed(readSealState(undefined), 1)).toBe(false);
    expect(isSeqSealed(readSealState([]), 1)).toBe(false);
    expect(hasSealedPart(readSealState([]))).toBe(false);
  });
});

/** A preview as a current writer stores it: the text, its source seq and its digest. */
const stamped = (text: string, seq: number, sealIntervals?: unknown) => ({
  lastMessagePreview: text,
  lastMessagePreviewSeq: seq,
  lastMessagePreviewDigest: previewDigest(text),
  ...(sealIntervals !== undefined ? { sealIntervals } : {}),
});

describe("readableThreadPreview", () => {
  it("shows a legacy thread's preview, with or without a source seq", () => {
    expect(readableThreadPreview({ lastMessagePreview: "hello" })).toBe("hello");
    expect(readableThreadPreview({ lastMessagePreview: "hello", lastMessagePreviewSeq: 2 })).toBe("hello");
  });

  it("withholds a preview whose source message is sealed", () => {
    expect(
      readableThreadPreview(stamped("my diagnosis", 4, [{ fromSeq: 1 }])),
    ).toBe("");
    // A retroactive seal (the opt-in seals the earlier part) covers an old preview too.
    expect(
      readableThreadPreview(stamped("old words", 2, [{ fromSeq: 1, toSeq: 6 }])),
    ).toBe("");
  });

  it("shows a preview taken from a message after the seal closed", () => {
    expect(
      readableThreadPreview(stamped("after opt-out", 7, [{ fromSeq: 1, toSeq: 6 }])),
    ).toBe("after opt-out");
  });

  it("withholds a preview with no source seq on a thread with any sealed part", () => {
    expect(readableThreadPreview({ lastMessagePreview: "unplaced", sealIntervals: [{ fromSeq: 1, toSeq: 2 }] })).toBe("");
    expect(
      readableThreadPreview({ lastMessagePreview: "unplaced", lastMessagePreviewSeq: "7", sealIntervals: [{ fromSeq: 1, toSeq: 2 }] }),
    ).toBe("");
  });

  it("withholds a preview whose digest is missing or does not match its text, on a sealed thread only", () => {
    const sealed = [{ fromSeq: 1, toSeq: 6 }];
    const { lastMessagePreviewDigest: _dropped, ...noDigest } = stamped("after opt-out", 7, sealed);
    expect(readableThreadPreview(noDigest)).toBe("");
    expect(readableThreadPreview({ ...stamped("after opt-out", 7, sealed), lastMessagePreviewDigest: previewDigest("other") })).toBe("");
    // A legacy thread shows its preview as stored, whatever the digest says.
    expect(readableThreadPreview({ ...stamped("hello", 2), lastMessagePreviewDigest: "stale" })).toBe("hello");
  });

  it("withholds every preview when the seal record is malformed", () => {
    expect(readableThreadPreview(stamped("x", 9, "garbage"))).toBe("");
  });

  it("reads an absent preview as empty", () => {
    expect(readableThreadPreview({})).toBe("");
  });
});

describe("the preview's source seq is recorded with the preview", () => {
  const NOW = "2026-10-02T00:00:00.000Z";
  const seed = (id: string): ThreadRow => ({
    id, userId: "u1", appId: "a1", servingRegion: "r", title: "t", status: "active",
    pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
  });

  it("stamps the seq of the message the preview came from, and keeps it when a card row leaves the preview alone", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(seed("t1"));
    const store = new ThreadStore(db);
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", content: "hi", text: "hi", clientMessageId: "c1" });
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "agent", content: "hello", text: "hello", clientMessageId: "c2" });
    expect((await db.getThread("t1"))?.lastMessagePreviewSeq).toBe(2);
    expect(await db.incrementSeq("t1", null, NOW)).toBe(3);
    const t = await db.getThread("t1");
    expect(t?.lastMessagePreview).toBe("hello");
    expect(t?.lastMessagePreviewSeq).toBe(2);
  });
});

describe("a preview replaced by a writer that does not stamp it", () => {
  const NOW = "2026-10-02T00:00:00.000Z";
  const seed = (id: string): ThreadRow => ({
    id, userId: "u1", appId: "a1", servingRegion: "r", title: "t", status: "active",
    pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
  });

  // The update a writer from before the stamp sends: the preview alone, the
  // previous seq and digest left standing.
  async function olderWriterAppend(db: InMemoryThreadPersistence, threadId: string, preview: string): Promise<number> {
    const t = await db.getThread(threadId);
    if (!t) throw new Error("no thread");
    t.lastSeq += 1;
    t.lastMessagePreview = preview;
    return t.lastSeq;
  }

  it("reads as source-unknown on a sealed thread: the stale seq does not vouch for the new text", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(seed("t1"));
    expect(await db.incrementSeq("t1", "readable words", NOW)).toBe(1);
    expect(await olderWriterAppend(db, "t1", "sealed words")).toBe(2);
    const t = await db.getThread("t1");
    expect(t?.lastMessagePreviewSeq).toBe(1);
    expect(readableThreadPreview({ ...t, sealIntervals: [{ fromSeq: 2 }] })).toBe("");
  });

  it("control: the current writer's own stamp is shown when its message is readable", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(seed("t1"));
    expect(await db.incrementSeq("t1", "sealed words", NOW)).toBe(1);
    expect(await db.incrementSeq("t1", "readable words", NOW)).toBe(2);
    const t = await db.getThread("t1");
    expect(readableThreadPreview({ ...t, sealIntervals: [{ fromSeq: 1, toSeq: 1 }] })).toBe("readable words");
  });
});

describe("an event row leaves the preview standing", () => {
  const NOW = "2026-10-02T00:00:00.000Z";
  const seed = (id: string): ThreadRow => ({
    id, userId: "u1", appId: "a1", servingRegion: "r", title: "t", status: "active",
    pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
  });

  it("a report row written after a closed seal never becomes the preview", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(seed("t1"));
    const store = new ThreadStore(db);
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", content: "private", text: "private", clientMessageId: "c1" });
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", content: "after opt-out", text: "after opt-out", clientMessageId: "c2" });
    const text = "Conversation report (svc).\nSummary: the private part, retold";
    const { seq } = await store.appendMessage({
      threadId: "t1", userId: "svc", role: "system", content: text, text, clientMessageId: "c3",
      kind: "event", event: { type: "report", summary: "the private part, retold", reportedBy: "svc" },
    });
    expect(seq).toBe(3);
    const t = await db.getThread("t1");
    expect(t?.lastSeq).toBe(3);
    expect(t?.lastMessagePreview).toBe("after opt-out");
    expect(t?.lastMessagePreviewSeq).toBe(2);
    expect(readableThreadPreview({ ...t, sealIntervals: [{ fromSeq: 1, toSeq: 1 }] })).toBe("after opt-out");
  });

  it("control: a plain message row still becomes the preview", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(seed("t1"));
    const store = new ThreadStore(db);
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", content: "hello", text: "hello", clientMessageId: "c1" });
    expect((await db.getThread("t1"))?.lastMessagePreview).toBe("hello");
  });
});
