/**
 * The widget's canonical invoke bodies, as builder inputs (guuey#1213, the
 * rolling-release rule). Test-only: `src/fixtures/**` is excluded from the
 * build and the npm pack, and no runtime module imports this file, so the
 * corpus ships in no bundle and no tarball. Its consumers are
 * `invoke-body.test.ts` and `write-widget-invoke-bodies.ts`.
 */
import type { InvokeBodyInput } from "../invoke-body.js";

/**
 * The canonical bodies the guuey WIDGET sends (`apps/widget` composes them
 * through `useAgentInvoke` with `preserveBlocks: true`, so the default
 * capabilities ride; a `guuey("page", …)` call adds the page block, and the
 * INIT origin stands in before any page call — guuey#1105). This list IS the
 * fixture: `invoke-body.test.ts` pins `fixtures/widget-invoke-bodies.json` to
 * it byte-for-byte, and the pod's rolling-release test consumes that file.
 * Add a case here when the widget starts sending a new shape.
 */
export const WIDGET_INVOKE_BODY_CASES: ReadonlyArray<{ name: string; why: string; input: InvokeBodyInput }> = [
  {
    name: "session-open-init-origin",
    why: "first contact: no threadId; the INIT origin stands in as a hostOrigin-only block (guuey#1105); default block-preserving capabilities",
    input: {
      input: "Hello",
      clientMessageId: "cm_0001",
      capabilities: { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } },
      pageContext: { hostOrigin: "https://customer.example" },
    },
  },
  {
    name: "turn-with-page",
    why: "a later turn after a guuey(\"page\", …) call: threadId replayed, full page block with context",
    input: {
      input: "What does this page say about pricing?",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_0002",
      capabilities: { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } },
      pageContext: {
        path: "/pricing",
        title: "Pricing — Acme",
        context: "Plans: Starter, Pro, Scale.",
        hostOrigin: "https://customer.example",
      },
    },
  },
  {
    name: "turn-with-page-no-context",
    why: "a page call without a host-declared context line (the common case)",
    input: {
      input: "Book a demo",
      threadId: "thr_01J8ZK3Q9X",
      clientMessageId: "cm_0003",
      capabilities: { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } },
      pageContext: { path: "/", title: "Acme", hostOrigin: "https://customer.example" },
    },
  },
  {
    name: "guest-mode-pin",
    why: "the embed pinned agent mode 'guest' (guuey#566) — carried verbatim",
    input: {
      input: "Hi",
      clientMessageId: "cm_0004",
      capabilities: { hitl: { ask: true, grantModes: true }, uiResources: { viewMessageTurns: true } },
      pageContext: { hostOrigin: "https://customer.example" },
      mode: "guest",
    },
  },
  {
    name: "sdk-minimal",
    why: "an SDK consumer with preserveBlocks off and no page: input + clientMessageId only",
    input: { input: "ping", clientMessageId: "cm_0005" },
  },
];
