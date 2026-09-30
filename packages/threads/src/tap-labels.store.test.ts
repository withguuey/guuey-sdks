/**
 * guuey#2031 — a card-action user row carries its tap labels, and the model
 * never sees them.
 *
 * The labels are display-only: the row's `text` and `content` stay the
 * directive the doorbell sent, and `loadHistory` (the model's lane) projects
 * named fields that never include the new attribute. The second test holds that
 * with a RED control: a store that wrote the labels into the model's text must
 * fail the same comparison.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryThreadPersistence } from "./in-memory.js";
import { ThreadStore, type StoredHistoryMessage, type ThreadMessageRow, type ThreadRow } from "./index.js";
import { isViewDirectiveText, readTapLabels, writeTapLabels, type TapLabels } from "./index.js";

const NOW = "2026-09-30T00:00:00.000Z";
const thread: ThreadRow = {
  id: "t1", userId: "u1", appId: "a1", servingRegion: "us-east-1", title: "x", status: "active",
  pinned: false, lastSeq: 0, lastMessageAt: NOW, lastMessagePreview: "", threadMode: "single", createdAt: NOW, updatedAt: NOW,
};

const DIRECTIVE = [
  'Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments {"sessionId":"render_s1"}.',
  '<ggui_directive kind="user-action">',
  "  <session_id>render_s1</session_id>",
  "  <next_tool>ggui_consume</next_tool>",
  "</ggui_directive>",
].join("\n");
const LABELS: TapLabels = ["Find me a mystery novel", null];

async function storeWithTap(db: InMemoryThreadPersistence, tapLabels?: TapLabels): Promise<ThreadStore> {
  await db.createThread({ ...thread });
  const store = new ThreadStore(db);
  await store.appendMessage({ threadId: "t1", userId: "u1", role: "user", clientMessageId: "u0", content: { kind: "text", text: "Hi!" }, text: "Hi!" });
  await store.appendMessage({
    threadId: "t1", userId: "u1", role: "user", clientMessageId: "u1",
    content: { kind: "text", text: DIRECTIVE }, text: DIRECTIVE, turnOrigin: "card_action",
    ...(tapLabels !== undefined ? { tapLabels } : {}),
  });
  return store;
}

describe("appendMessage carries a row's tap labels verbatim", () => {
  it("writes tapLabels when given, and the key is ABSENT when not", async () => {
    const labeled = new InMemoryThreadPersistence();
    await storeWithTap(labeled, LABELS);
    const plain = new InMemoryThreadPersistence();
    await storeWithTap(plain);
    const [, tapRow] = await labeled.listRecentMessages("t1", 10);
    expect(tapRow?.tapLabels).toEqual(LABELS);
    const [, plainRow] = await plain.listRecentMessages("t1", 10);
    expect(plainRow).toBeDefined();
    // Absent, never undefined-valued: an older reader sees the row it always saw.
    expect(Object.keys(plainRow ?? {})).not.toContain("tapLabels");
    // The directive stays the row's text and content, byte for byte.
    expect(tapRow?.text).toBe(DIRECTIVE);
    expect(tapRow?.content).toEqual({ kind: "text", text: DIRECTIVE });
  });
});

/** The model's lane, projected to what reaches a prompt. */
async function modelView(store: ThreadStore): Promise<StoredHistoryMessage[]> {
  return store.loadHistory("t1");
}

/** A deliberately BROKEN binding: it writes a user row's labels into the model's text (the RED control). */
class LabelsIntoTextPersistence extends InMemoryThreadPersistence {
  override async putMessage(row: ThreadMessageRow): Promise<void> {
    const labels = row.tapLabels?.filter((l): l is string => l !== null) ?? [];
    return super.putMessage(labels.length > 0 ? { ...row, text: labels.join(" "), content: { kind: "text", text: labels.join(" ") } } : row);
  }
}

describe("the model's history is unchanged by tap labels", () => {
  // One clock for both stores: a row's `at` is part of the lane, and the comparison is of everything else.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loadHistory is deep-equal for the same thread with and without labels", async () => {
    const withLabels = await modelView(await storeWithTap(new InMemoryThreadPersistence(), LABELS));
    const without = await modelView(await storeWithTap(new InMemoryThreadPersistence()));
    expect(withLabels).toEqual(without);
  });

  it("RED control: a store that put the labels into the model's text fails the same comparison", async () => {
    const broken = await modelView(await storeWithTap(new LabelsIntoTextPersistence(), LABELS));
    const without = await modelView(await storeWithTap(new InMemoryThreadPersistence()));
    expect(broken).not.toEqual(without);
  });
});

describe("the contract names re-exported for the persistence side", () => {
  it("the writer, the reader and the predicate reach a server through @guuey/threads", () => {
    expect(writeTapLabels(["ok", null])).toEqual(["ok", null]);
    expect(readTapLabels(["a".repeat(300)])).toHaveLength(1);
    expect(isViewDirectiveText(DIRECTIVE)).toBe(true);
  });
});
