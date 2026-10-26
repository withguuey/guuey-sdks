/**
 * The ONE title door (guuey#2612): `ThreadStore.writeTitle`
 * answers `unsupported` itself, once, for every kind of write, whenever the
 * binding has no `writeTitle`. No binding answers it, and the HTTP binding
 * (self-hosted threads get no titles in v1) leaves the method out.
 */
import { describe, expect, it } from "vitest";
import { HttpThreadPersistence } from "./http.js";
import { InMemoryThreadPersistence } from "./in-memory.js";
import type { ThreadPersistencePort } from "./rows.js";
import { ThreadStore } from "./store.js";
import type { TitleWrite } from "./title.js";

const AT = "2026-10-27T00:00:00.000Z";

const WRITES: ReadonlyArray<TitleWrite> = [
  { kind: "claim", checkpoint: 2, at: AT },
  { kind: "record", checkpoint: 2, title: "Trip to Busan", sourceSeq: 2, at: AT },
  { kind: "set", userId: "g_owner", title: "Mine", at: AT },
  { kind: "set", userId: "g_owner", title: null, at: AT },
];

/** The in-memory binding with `writeTitle` left out: a binding that cannot title. */
function portWithoutTitles(): ThreadPersistencePort {
  const db = new InMemoryThreadPersistence();
  return {
    getThread: (id) => db.getThread(id),
    createThread: (row) => db.createThread(row),
    incrementSeq: (id, preview, at) => db.incrementSeq(id, preview, at),
    putMessage: (row) => db.putMessage(row),
    listRecentMessages: (id, limit) => db.listRecentMessages(id, limit),
    findByClientMessageId: (id, cmid) => db.findByClientMessageId(id, cmid),
    getSnapshot: (id) => db.getSnapshot(id),
    putSnapshot: (row) => db.putSnapshot(row),
  };
}

describe("ThreadStore.writeTitle — the one door", () => {
  it.each(WRITES)("answers unsupported for a $kind over a binding without writeTitle, and the row is untouched", async (write) => {
    const port = portWithoutTitles();
    const store = new ThreadStore(port);
    const threadId = await store.ensureThread({ userId: "g_owner", appId: "app_1", region: "us-east-1" });
    const before = await port.getThread(threadId);
    expect(await store.writeTitle(threadId, write)).toBe("unsupported");
    expect(await port.getThread(threadId)).toEqual(before);
  });

  it("the HTTP binding leaves writeTitle out, so its store answers unsupported without a request", async () => {
    let requests = 0;
    const http = new HttpThreadPersistence({
      baseUrl: "https://threads.example.test",
      token: "t",
      appId: "app_1",
      fetchImpl: async () => {
        requests += 1;
        return new Response("{}", { status: 500 });
      },
    });
    expect("writeTitle" in http).toBe(false);
    const store = new ThreadStore(http);
    for (const write of WRITES) expect(await store.writeTitle("t1", write)).toBe("unsupported");
    expect(requests).toBe(0);
  });

  it("forwards to a binding that implements writeTitle", async () => {
    const db = new InMemoryThreadPersistence();
    const store = new ThreadStore(db);
    const threadId = await store.ensureThread({ userId: "g_owner", appId: "app_1", region: "us-east-1" });
    expect(await store.writeTitle(threadId, { kind: "claim", checkpoint: 2, at: AT })).toBe("written");
    expect(await store.writeTitle(threadId, { kind: "claim", checkpoint: 2, at: AT })).toBe("refused");
  });
});
