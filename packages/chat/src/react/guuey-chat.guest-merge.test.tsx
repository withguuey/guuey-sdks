// @vitest-environment jsdom
/**
 * `<GuueyChat>` — the guest → signed-in transition. When the host hands the
 * kit a bearer where it had only a guest identity, the kit moves the guest's
 * threads in this app to the signed-in user (`mergeGuestThreads`), keeps the
 * SAME thread, and rotates the guest secret only once the merge succeeded.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentInvokeAdapters, InvokeRequest } from "@guuey/agent-client";
import { GuueyChat, type GuueyChatHandle, type GuueyChatProps } from "./guuey-chat.js";
import type { ChatDebugEvent } from "../types.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SESSION_FRAME = 'event: session\ndata: {"threadId":"t-guest"}\n\n';
const DONE_FRAME = 'event: done\ndata: {"stopReason":"end"}\n\n';
const OLD_SECRET = "1".repeat(64);
const NEW_SECRET = "2".repeat(64);

function scriptedAdapters() {
  const calls: InvokeRequest[] = [];
  const store = new Map<string, string>();
  const adapters: AgentInvokeAdapters = {
    storage: {
      load: (key) => store.get(key) ?? null,
      save: (key, threadId) => {
        store.set(key, threadId);
      },
    },
    generateId: (() => {
      let n = 0;
      return () => `cmid-${n++}`;
    })(),
    transport: async function* (req) {
      calls.push(req);
      yield SESSION_FRAME;
      yield DONE_FRAME;
    },
  };
  return { adapters, calls };
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(response: () => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      calls.push({ url: String(url), init });
      return response();
    }),
  );
  return calls;
}

/** Render as a guest, send one turn so the thread exists, and hand back a rerender into the signed-in state. */
async function startAsGuest(extra: Partial<GuueyChatProps>) {
  const { adapters, calls } = scriptedAdapters();
  let secret = OLD_SECRET;
  const rotations: string[] = [];
  const debug: ChatDebugEvent[] = [];
  const ref = createRef<GuueyChatHandle>();
  const base: GuueyChatProps = {
    endpointUrl: "https://pod.example/agent/invoke",
    adapters,
    apiBaseUrl: "https://api.example/v1",
    appId: "app-a",
    onGuestSecretRotate: () => {
      rotations.push(secret);
      secret = NEW_SECRET;
    },
    onDebugEvent: (e) => debug.push(e),
    ...extra,
  };
  const view = render(<GuueyChat ref={ref} {...base} getGuestSecret={() => secret} />);
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: "save my flashcards" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(calls).toHaveLength(1));
  await waitFor(() => expect(ref.current?.threadId).toBe("t-guest"));
  const signIn = (): void => {
    view.rerender(<GuueyChat ref={ref} {...base} getAccessToken={async () => "byo-token"} />);
  };
  return { ref, rotations, debug, signIn };
}

describe("guest → signed-in: the kit merges the guest's threads and keeps the thread", () => {
  it("POSTs the merge with the bearer, the PRE-rotation guest secret and the open thread; then rotates once; the thread id is unchanged", async () => {
    const fetches = stubFetch(() => new Response(JSON.stringify({ moved: 1, skipped: 0 }), { status: 200 }));
    const { ref, rotations, debug, signIn } = await startAsGuest({});

    act(() => signIn());

    await waitFor(() => expect(rotations).toEqual([OLD_SECRET]));
    const merges = fetches.filter((f) => f.url === "https://api.example/v1/agents/app-a/merge-guest");
    expect(merges).toHaveLength(1);
    const headers = merges[0]!.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer byo-token");
    expect(headers["x-guuey-guest"]).toBe(OLD_SECRET);
    expect(JSON.parse(String(merges[0]!.init?.body))).toEqual({ threadIds: ["t-guest"] });
    expect(ref.current?.threadId).toBe("t-guest");
    expect(debug).toContainEqual({ type: "guest-merge", threadId: "t-guest", outcome: "merged", moved: 1 });
  });

  it("a plane without the route (404): no rotation, the debug line says unsupported", async () => {
    stubFetch(() => new Response("{}", { status: 404 }));
    const { rotations, debug, signIn } = await startAsGuest({});
    act(() => signIn());
    await waitFor(() => expect(debug).toContainEqual({ type: "guest-merge", threadId: "t-guest", outcome: "unsupported" }));
    expect(rotations).toEqual([]);
  });

  it("a refused merge keeps the guest secret (nothing rotates) and says failed", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429 }));
    const { rotations, debug, signIn } = await startAsGuest({});
    act(() => signIn());
    await waitFor(() => expect(debug).toContainEqual({ type: "guest-merge", threadId: "t-guest", outcome: "failed" }));
    expect(rotations).toEqual([]);
  });

  it("no apiBaseUrl or no appId: no call, the debug line says skipped", async () => {
    const fetches = stubFetch(() => new Response("{}", { status: 200 }));
    const { debug, signIn } = await startAsGuest({ appId: undefined });
    act(() => signIn());
    await waitFor(() => expect(debug).toContainEqual({ type: "guest-merge", threadId: "t-guest", outcome: "skipped" }));
    expect(fetches.filter((f) => f.url.includes("merge-guest"))).toHaveLength(0);
  });

  it("a surface that starts signed in never merges", async () => {
    const fetches = stubFetch(() => new Response("{}", { status: 200 }));
    const { adapters } = scriptedAdapters();
    render(
      <GuueyChat
        endpointUrl="https://pod.example/agent/invoke"
        adapters={adapters}
        apiBaseUrl="https://api.example/v1"
        appId="app-a"
        getAccessToken={async () => "byo-token"}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetches.filter((f) => f.url.includes("merge-guest"))).toHaveLength(0);
  });
});
