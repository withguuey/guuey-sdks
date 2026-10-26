// @vitest-environment jsdom
/**
 * guuey#2445 — an adoption clears the send ledger for every send history
 * holds. A send whose transport threw before admission is marked `failed`,
 * but the pod may have stored and answered it anyway; once keyed history
 * holds its row, history is the authority that it was stored, and the send
 * reads as sent (absent from the ledger), so no Retry sends it twice.
 */
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, AgentMessage, InvokeRequest } from "./types.js";

const SESSION = 'event: session\ndata: {"threadId":"t-ledger"}\n\n';
const DONE = 'event: done\ndata: {"stopReason":"end"}\n\n';
const answer = (text: string): string =>
  `event: message\ndata: ${JSON.stringify({ type: "text.delta", delta: text })}\n\n`;

const HISTORY: AgentMessage[] = [
  { role: "user", text: "Q1", seq: 1, clientMessageId: "cm-1" },
  { role: "assistant", text: "A1", seq: 2 },
  { role: "user", text: "Q2", seq: 3, clientMessageId: "cm-2" },
  { role: "assistant", text: "A2", seq: 4 },
  { role: "user", text: "Q3", seq: 5, clientMessageId: "cm-3" },
  { role: "assistant", text: "A3", seq: 6 },
];

describe("useAgentInvoke — an adoption clears the ledger for every send history holds", () => {
  it("drops a failed send's entry once keyed history shows it was stored", async () => {
    let ids = 0;
    let call = 0;
    const adapters: AgentInvokeAdapters = {
      storage: { load: () => null, save: () => {} },
      generateId: () => `cm-${++ids}`,
      history: { load: async () => ({ messages: HISTORY }) },
      transport: (_req: InvokeRequest) => {
        const n = call++;
        return (async function* (): AsyncGenerator<string> {
          // Q2: refused before its first chunk (a 503 before the pod admits it).
          if (n === 1) throw new Error("503 before admission");
          yield SESSION;
          yield answer(`A${n + 1}`);
          // Q3's stream is cut after its answer (no `done`): history is read and adopted.
          if (n !== 2) yield DONE;
        })();
      },
    };
    const { result } = renderHook(() =>
      useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: "app-ledger", adapters, stallRecovery: false }),
    );

    await act(async () => {
      await result.current.send("Q1");
    });
    await act(async () => {
      await result.current.send("Q2");
    });
    expect(result.current.sendStates).toEqual({ "cm-2": "failed" });

    await act(async () => {
      await result.current.send("Q3");
    });
    expect(result.current.adopted).toBe(true);
    expect(result.current.sendStates).toEqual({});

    await act(async () => {
      await result.current.send("Q4");
    });
    expect(result.current.sendStates).toEqual({});
  });
});
