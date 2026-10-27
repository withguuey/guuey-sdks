/**
 * guuey#2549 — a user row whose content rode on the page context: empty text, `inputKind`
 * stored, and carried into the model's history lane so the worker can replay its one substitution.
 */
import { describe, expect, it } from "vitest";
import { InMemoryThreadPersistence } from "./in-memory.js";
import { THREAD_INPUT_KINDS, ThreadStore, readThreadInputKind, type ThreadRow } from "./index.js";

const NOW = "2026-10-22T00:00:00.000Z";
const thread: ThreadRow = {
  id: "t1", userId: "u1", appId: "a1", servingRegion: "us-east-1", title: "x", status: "active",
  pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
};

async function seeded(): Promise<{ db: InMemoryThreadPersistence; store: ThreadStore }> {
  const db = new InMemoryThreadPersistence();
  await db.createThread({ ...thread });
  const store = new ThreadStore(db);
  await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", clientMessageId: "u0", content: { kind: "text", text: "Hi" }, text: "Hi" });
  await store.appendMessage({
    threadId: "t1", userId: "u1", role: "user", clientMessageId: "u1",
    content: { kind: "text", text: "" }, text: "", inputKind: "context-only",
  });
  return { db, store };
}

describe("a context-only user row (guuey#2549)", () => {
  it("the kinds start with context-only", () => {
    expect(THREAD_INPUT_KINDS).toEqual(["context-only"]);
  });

  it("stores inputKind with empty text; the key is absent on an ordinary row", async () => {
    const { db } = await seeded();
    const [plain, photo] = await db.listRecentMessages("t1", 10);
    expect(photo?.inputKind).toBe("context-only");
    expect(photo?.text).toBe("");
    expect(Object.keys(plain ?? {})).not.toContain("inputKind");
  });

  it("leaves the thread's preview standing: a turn without words has no words to preview", async () => {
    const { db } = await seeded();
    expect((await db.getThread("t1"))?.lastMessagePreview).toBe("Hi");
  });

  it("reads a stored kind through the reader contract: a known kind, else nothing, never a throw", () => {
    expect(readThreadInputKind("context-only")).toBe("context-only");
    expect(readThreadInputKind("telepathy")).toBeUndefined();
    expect(readThreadInputKind(["context-only"])).toBeUndefined();
    expect(readThreadInputKind(undefined)).toBeUndefined();
  });

  it("carries inputKind into the history lane, and only on that row", async () => {
    const { store } = await seeded();
    const history = await store.loadHistory("t1", 10);
    const kinds = history.map((m) => m.inputKind);
    expect(kinds).toEqual([undefined, "context-only"]);
    expect(Object.keys(history[0] ?? {})).not.toContain("inputKind");
  });
});
