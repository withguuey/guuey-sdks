import { describe, expect, it } from "vitest";
import { Reducer, type AgEvent } from "@silverprotocol/core";
import { InMemoryThreadPersistence } from "./in-memory.js";
import {
  AGENT_ERROR_ROW_SUFFIX,
  classifyStoredRow,
  ThreadStore,
  type ThreadRow,
} from "./index.js";

const NOW = "2026-09-27T00:00:00.000Z";
const thread: ThreadRow = {
  id: "t1", userId: "u1", appId: "a1", servingRegion: "us-east-1", title: "x", status: "active",
  pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
};

/** A failure row as the runtime writes it after codes were persisted (`sse-server.ts` voiceTurnFailure). */
const failureWithCode = { kind: "text", text: "The reply didn't come through.", error: { code: "NO_REPLY", detail: "token_limit" } };
/** The same row's content BEFORE codes were persisted (2026-08-23 through the CONTENT_BLOCKED release). */
const failureBeforeCodes = { kind: "text", text: "Something went wrong on our side while writing this reply." };
/** A framework notice as the pinned Claude facet stores it (role "notice", the level on the block's `_meta`). */
const storedNotice = {
  id: "n1", role: "notice", noticeSource: "framework", threadId: "t1",
  content: [{ type: "text", text: "claude-sonnet-5's safeguards stopped the response above · continuing once with that noted", _meta: { level: "notice" } }],
};
/** A blank agent message (the #1888 shape: an empty signed part and an empty ADK carry). */
const storedBlank = {
  id: "b1", role: "assistant", threadId: "t1",
  content: [{ type: "text", text: "" }, { type: "provider-raw", vendor: "google", raw: { artifactDelta: {} } }],
};
const storedAnswer = { id: "a1", role: "assistant", threadId: "t1", content: [{ type: "text", text: "Here it is." }] };

describe("classifyStoredRow", () => {
  it("a failure row of EITHER vintage is a failure: keyed on the #agentError suffix, the code read when stored", () => {
    expect(classifyStoredRow({ clientMessageId: `c1${AGENT_ERROR_ROW_SUFFIX}`, authorRole: "agent", content: failureWithCode })).toEqual({
      kind: "failure",
      code: "NO_REPLY",
    });
    expect(classifyStoredRow({ clientMessageId: `c1${AGENT_ERROR_ROW_SUFFIX}`, authorRole: "agent", content: failureBeforeCodes })).toEqual({
      kind: "failure",
      code: null,
    });
    // A content-carried code classifies even under another key.
    expect(classifyStoredRow({ clientMessageId: "c1#agent#0", authorRole: "agent", content: failureWithCode })).toEqual({ kind: "failure", code: "NO_REPLY" });
  });

  it("a stored notice is a notice with its source; a blank agent message is blank", () => {
    expect(classifyStoredRow({ clientMessageId: "c1#agentTurn", authorRole: "agent", content: storedNotice })).toEqual({ kind: "notice", source: "framework" });
    expect(classifyStoredRow({ clientMessageId: "c1#agentTurn", authorRole: "agent", content: storedBlank })).toEqual({ kind: "blank" });
  });

  it("everything else is conversation: an answer, a user row, a legacy row whose content is not a stored message", () => {
    expect(classifyStoredRow({ clientMessageId: "c1#agentTurn", authorRole: "agent", content: storedAnswer })).toEqual({ kind: "conversation" });
    expect(classifyStoredRow({ clientMessageId: "u1", authorRole: "user", content: "hello" })).toEqual({ kind: "conversation" });
    expect(classifyStoredRow({ clientMessageId: "m1", authorRole: "agent", content: "plain text" })).toEqual({ kind: "conversation" });
  });
});

describe("loadHistory replays only conversation", () => {
  async function seeded() {
    const db = new InMemoryThreadPersistence();
    await db.createThread(thread);
    const store = new ThreadStore(db);
    const say = (role: "user" | "agent", clientMessageId: string, content: unknown, text: string) =>
      store.appendMessage({ threadId: "t1", userId: "u1", role, clientMessageId, content, text });
    await say("user", "u1", "first question", "first question");
    await say("agent", `u1${AGENT_ERROR_ROW_SUFFIX}`, failureBeforeCodes, failureBeforeCodes.text);
    await say("user", "u2", "second question", "second question");
    await say("agent", "u2#agentTurn", storedNotice, storedNotice.content[0]!.text);
    await say("agent", "u2#agent#1", storedBlank, "");
    await say("agent", "u2#agent#2", storedAnswer, "Here it is.");
    await say("user", "u3", "third question", "third question");
    await say("agent", `u3${AGENT_ERROR_ROW_SUFFIX}`, failureWithCode, failureWithCode.text);
    return { db, store };
  }

  it("the failure (both vintages), the notice and the blank row are gone; every conversation row stays, in order", async () => {
    const { store } = await seeded();
    const history = await store.loadHistory("t1");
    expect(history.map((m) => [m.authorRole, m.text])).toEqual([
      ["user", "first question"],
      ["user", "second question"],
      ["agent", "Here it is."],
      ["user", "third question"],
    ]);
  });

  it("every other reader keeps one row per stored message", async () => {
    const { db } = await seeded();
    expect(await db.listRecentMessages("t1", 50)).toHaveLength(8);
  });

});

describe("a framework notice never becomes the thread preview", () => {
  it("the preview keeps the prior answer when a turn stores only a notice", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(thread);
    const store = new ThreadStore(db);
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "agent", clientMessageId: "a0", content: storedAnswer, text: "Here it is." });
    const events: AgEvent[] = [
      { seq: 0, type: "turn.start", threadId: "t1", turnId: "tn" },
      { seq: 1, type: "message.start", id: "n1", role: "notice", turnId: "tn", threadId: "t1", noticeSource: "framework" },
      { seq: 2, type: "content.block", messageId: "n1", block: { type: "text", text: "safeguards stopped the response above", _meta: { level: "notice" } } },
      { seq: 3, type: "message.end", id: "n1" },
      { seq: 4, type: "turn.done", turnId: "tn", outcome: { type: "success" }, finishReason: "stop" },
    ];
    const reducer = new Reducer();
    for (const e of events) reducer.push(e);
    const fold = reducer.result();
    // Precondition: the fold really carries the notice, so the preview check below is not vacuous.
    expect(fold.messages.map((m) => m.role)).toEqual(["notice"]);
    await store.appendFold({ threadId: "t1", userId: "u1", fold, clientMessageIdBase: "u2" });
    const rows = await db.listRecentMessages("t1", 10);
    expect(rows.map((r) => classifyStoredRow(r).kind)).toEqual(["conversation", "notice"]);
    expect((await db.getThread("t1"))?.lastMessagePreview).toBe("Here it is.");
  });
});

describe("a user row's origin and client class are carried verbatim", () => {
  it("appendMessage writes turnOrigin, answeredCardSessionId and clientClass when given, and nothing when not", async () => {
    const db = new InMemoryThreadPersistence();
    await db.createThread(thread);
    const store = new ThreadStore(db);
    await store.appendMessage({
      threadId: "t1", userId: "u1", role: "user", clientMessageId: "u1", content: "hi", text: "hi",
      turnOrigin: "card_action", answeredCardSessionId: "render_abc", clientClass: "operator",
    });
    await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", clientMessageId: "u2", content: "again", text: "again" });
    const [stamped, plain] = await db.listRecentMessages("t1", 10);
    expect(stamped).toMatchObject({ turnOrigin: "card_action", answeredCardSessionId: "render_abc", clientClass: "operator" });
    // Absent, never undefined-valued: an older reader sees the row it always saw.
    expect(Object.keys(plain!)).not.toContain("turnOrigin");
    expect(Object.keys(plain!)).not.toContain("answeredCardSessionId");
    expect(Object.keys(plain!)).not.toContain("clientClass");
  });
});
