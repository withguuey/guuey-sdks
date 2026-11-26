/**
 * The canonical request-shape-2 bodies, as builder inputs (W6). Test-only: `src/fixtures/**` is excluded from the build
 * and the npm pack, and no runtime module imports this file. `invoke-body-v2.test.ts` builds each case, runs it through
 * silverprotocol's own receiver check, and pins `fixtures/agjson-corpus/next.json` to the built bodies, the set the
 * next release adds to the corpus. Add a case here when the client starts sending a new shape-2 body.
 */
import type { InvokeBodyV2Input } from "../invoke-body-v2.js";

const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const INVOKE_BODY_V2_CASES: ReadonlyArray<{ name: string; why: string; input: InvokeBodyV2Input }> = [
  {
    name: "text-turn",
    why: "a later turn with words: the thread replayed, the widget's capabilities and page block (guuey metadata, untrusted)",
    input: {
      text: "What does this page say about pricing?",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_v2_0001",
      capabilities: { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } },
      pageContext: { path: "/pricing", title: "Pricing — Acme", hostOrigin: "https://customer.example" },
    },
  },
  {
    name: "context-only-turn",
    why: "a turn without words: no text block, the kind in the guuey metadata",
    input: { text: "", threadId: "thr_01J8ZK3Q9X", clientMessageId: "cm_v2_0002", inputKind: "context-only" },
  },
  {
    name: "first-contact",
    why: "the first turn of a conversation: threadId \"\" (the runtime mints one); a mode pin",
    input: {
      text: "Hello",
      clientMessageId: "cm_v2_0003",
      pageContext: { hostOrigin: "https://customer.example" },
      mode: "guest",
    },
  },
  {
    name: "parts-and-turn-context",
    why: "every part kind and source after the words, the message's context as run.context, a tap's words",
    input: {
      text: "Compare these against my plan",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_v2_0004",
      parts: [
        { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX_BASE64 } },
        { type: "audio", source: { type: "url", url: "https://files.example/note.mp3", mediaType: "audio/mpeg" } },
        { type: "file", source: { type: "base64", mediaType: "text/csv", data: "cGxhbixwcmljZQo=" }, filename: "plans.csv" },
        { type: "document", source: { type: "file", fileId: "upl_01J8ZK3QA0" }, title: "Terms" },
      ],
      turnContext: [{ type: "text", text: "The visitor is on the Pro plan." }],
      tapLabels: ["Compare plans"],
    },
  },
];
