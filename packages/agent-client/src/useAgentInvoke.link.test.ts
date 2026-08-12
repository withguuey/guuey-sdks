// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentInvoke } from "./useAgentInvoke.js";
import type { AgentInvokeAdapters, InvokeRequest, UseAgentInvokeOptions } from "./types.js";

const APP_ID = "app-link";

/** SSE frame carrying the cross-app profile LINK invite (T3 pod event). */
const linkFrame = (data: unknown) =>
  `event: profile-link-needed\ndata: ${JSON.stringify(data)}\n\n`;
/** An event name the hook has no branch for — must fall through silently. */
const unknownFrame = (data: unknown) =>
  `event: some-future-event\ndata: ${JSON.stringify(data)}\n\n`;

function makeAdapters(frames: string[]): AgentInvokeAdapters {
  const store: Record<string, string> = {};
  return {
    storage: {
      load: (k) => (k in store ? store[k] : null),
      save: (k, v) => {
        store[k] = v;
      },
    },
    generateId: () => "cmid-test",
    transport: async function* (_req: InvokeRequest): AsyncGenerator<string> {
      yield 'event: session\ndata: {"threadId":"t1"}\n\n';
      for (const f of frames) yield f;
      yield "event: done\ndata: {}\n\n";
    },
  };
}

function mount(frames: string[], extra?: Partial<UseAgentInvokeOptions>) {
  const adapters = makeAdapters(frames);
  return renderHook(() =>
    useAgentInvoke({ endpointUrl: "https://pod.example.com", appId: APP_ID, adapters, ...extra }),
  );
}

describe("useAgentInvoke profile-link-needed", () => {
  it("sets profileLinkRequest from a well-formed link event", async () => {
    const { result, unmount } = mount([linkFrame({ appId: "app_1", requested: "read-write" })]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toEqual({ appId: "app_1", requested: "read-write" });
    unmount();
  });

  it("ignores a malformed link payload (empty appId) — field stays null", async () => {
    const { result, unmount } = mount([linkFrame({ appId: "", requested: "read-write" })]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toBeNull();
    unmount();
  });

  it("ignores a link payload with an out-of-range access level", async () => {
    const { result, unmount } = mount([linkFrame({ appId: "app_1", requested: "write" })]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toBeNull();
    unmount();
  });

  it("tolerates extra junk on an otherwise-valid payload", async () => {
    const { result, unmount } = mount([
      linkFrame({ appId: "app_1", requested: "read", extra: 1, nested: { x: true } }),
    ]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toEqual({ appId: "app_1", requested: "read" });
    unmount();
  });

  it("still falls through unknown events silently (no link request, no error)", async () => {
    const { result, unmount } = mount([unknownFrame({ whatever: true })]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toBeNull();
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("clearProfileLinkRequest() resets the field to null", async () => {
    const { result, unmount } = mount([linkFrame({ appId: "app_1", requested: "read" })]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).not.toBeNull();
    await act(async () => {
      result.current.clearProfileLinkRequest();
    });
    expect(result.current.profileLinkRequest).toBeNull();
    unmount();
  });

  it("is independent of profileConsentRequest — both can be set from the same turn", async () => {
    const consentFrame = (data: unknown) =>
      `event: profile-consent-needed\ndata: ${JSON.stringify(data)}\n\n`;
    const { result, unmount } = mount([
      linkFrame({ appId: "app_1", requested: "read" }),
      consentFrame({ appId: "app_2", requested: "read-write" }),
    ]);
    await act(async () => {
      await result.current.send("hi");
    });
    expect(result.current.profileLinkRequest).toEqual({ appId: "app_1", requested: "read" });
    expect(result.current.profileConsentRequest).toEqual({ appId: "app_2", requested: "read-write" });
    unmount();
  });
});
