import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachViewHost,
  viewDocumentHtml,
  type ViewFrameLike,
  type ViewHostEvents,
} from "./view-host.js";
import type { ViewHostOutbound, ViewHostPhase } from "./view-host-protocol.js";

// The glue, exercised through its injectable seams (fake frame + fake
// event source) in plain Node — no DOM. What genuinely needs a browser
// (sandbox physics, real postMessage identity) lives in the monorepo's
// e2e leg; everything decision-shaped is already covered by the machine
// suite. This file pins the WIRING: identity filter, effect execution,
// timer, detach.

interface Posted {
  message: ViewHostOutbound;
  targetOrigin: string;
}

function fakeFrame(size: { width: number; height: number } = { width: 400, height: 300 }): {
  frame: ViewFrameLike;
  posted: Posted[];
  contentWindow: object;
} {
  const posted: Posted[] = [];
  // The glue only ever posts envelopes it built itself; declaring the fake's
  // parameter as ViewHostOutbound keeps assertions typed (method bivariance
  // makes the fake satisfy ViewFrameLike without a cast).
  const contentWindow = {
    postMessage(message: ViewHostOutbound, targetOrigin: string): void {
      posted.push({ message, targetOrigin });
    },
  };
  return {
    frame: { contentWindow, clientWidth: size.width, clientHeight: size.height },
    posted,
    contentWindow,
  };
}

function fakeEvents(): {
  events: ViewHostEvents;
  emit: (data: unknown, source: unknown) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: { data: unknown; source: unknown }) => void>();
  return {
    events: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    emit: (data, source) => {
      for (const listener of [...listeners]) listener({ data, source });
    },
    listenerCount: () => listeners.size,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: { appInfo: { name: "v", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" },
};

describe("attachViewHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers the frame's ui/initialize and reports the connected phase", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const phases: ViewHostPhase[] = [];
    attachViewHost(frame, { events, onPhaseChange: (p) => phases.push(p) });

    emit(INITIALIZE, contentWindow);

    expect(posted).toHaveLength(1);
    expect(posted[0]?.targetOrigin).toBe("*");
    expect(posted[0]?.message.id).toBe(1);
    expect(posted[0]?.message.result?.["protocolVersion"]).toBe("2026-01-26");
    expect(phases).toEqual(["connected"]);
  });

  it("derives container dimensions only when the frame has laid out", () => {
    const laidOut = fakeFrame({ width: 500, height: 250 });
    const preLayout = fakeFrame({ width: 0, height: 0 });
    for (const { frame, posted, contentWindow } of [laidOut, preLayout]) {
      const { events, emit } = fakeEvents();
      attachViewHost(frame, { events });
      emit(INITIALIZE, contentWindow);
      expect(posted).toHaveLength(1);
    }
    const laidOutContext = laidOut.posted[0]?.message.result?.["hostContext"];
    expect(laidOutContext).toMatchObject({
      containerDimensions: { width: 500, height: 250 },
    });
    const preLayoutContext = preLayout.posted[0]?.message.result?.["hostContext"];
    expect(preLayoutContext).not.toHaveProperty("containerDimensions");
  });

  it("configured hostContext keys win over derived ones", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, { events, hostContext: { locale: "ko-KR" } });
    emit(INITIALIZE, contentWindow);
    expect(posted[0]?.message.result?.["hostContext"]).toMatchObject({ locale: "ko-KR" });
  });

  it("ignores messages whose source is not the frame's window — the identity filter", () => {
    const { frame, posted } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, { events });

    emit(INITIALIZE, { some: "other window" });
    emit(INITIALIZE, null);

    expect(posted).toEqual([]);
  });

  it("matches nothing when the frame has no contentWindow", () => {
    const { events, emit } = fakeEvents();
    const frame: ViewFrameLike = { contentWindow: null, clientWidth: 0, clientHeight: 0 };
    attachViewHost(frame, { events });
    emit(INITIALIZE, null);
    // Nothing to assert on posts (no window to post to) — the property is
    // that a null window matches no source, so no throw and no handling.
  });

  it("lapses to no-handshake after the negotiation window, once", () => {
    const { frame, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const phases: ViewHostPhase[] = [];
    attachViewHost(frame, { events, negotiationTimeoutMs: 100, onPhaseChange: (p) => phases.push(p) });

    vi.advanceTimersByTime(99);
    expect(phases).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["no-handshake"]);

    // A late handshake still connects (the timeout labels, it does not lock).
    emit(INITIALIZE, contentWindow);
    expect(phases).toEqual(["no-handshake", "connected"]);
  });

  it("does not lapse a connected view", () => {
    const { frame, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const phases: ViewHostPhase[] = [];
    attachViewHost(frame, { events, negotiationTimeoutMs: 100, onPhaseChange: (p) => phases.push(p) });
    emit(INITIALIZE, contentWindow);
    vi.advanceTimersByTime(1000);
    expect(phases).toEqual(["connected"]);
  });

  it("never times out when the timer is disabled", () => {
    const { frame } = fakeFrame();
    const { events } = fakeEvents();
    const phases: ViewHostPhase[] = [];
    attachViewHost(frame, { events, negotiationTimeoutMs: 0, onPhaseChange: (p) => phases.push(p) });
    vi.advanceTimersByTime(1_000_000);
    expect(phases).toEqual([]);
  });

  it("relays tools/call through the hook and posts the settled result", async () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const calls: unknown[] = [];
    attachViewHost(frame, {
      events,
      resourceUri: "ui://card/1",
      onCallTool: (request) => {
        calls.push(request);
        return Promise.resolve({ content: [{ type: "text", text: "done" }] });
      },
    });

    emit(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ggui_runtime_submit_action", arguments: { a: 1 } },
      },
      contentWindow,
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    expect(calls).toEqual([
      { resourceUri: "ui://card/1", name: "ggui_runtime_submit_action", arguments: { a: 1 } },
    ]);
    expect(posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "done" }] },
    });
  });

  it("answers in-band unavailable when the relay hook rejects — the view is never left hanging", async () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, {
      events,
      resourceUri: "ui://card/1",
      onCallTool: () => Promise.reject(new Error("embedder bug")),
    });
    emit(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "x" } },
      contentWindow,
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.message.result?.["isError"]).toBe(true);
  });

  it("advertises serverTools automatically when (and only when) the relay is wired", () => {
    const wired = fakeFrame();
    const wiredEvents = fakeEvents();
    attachViewHost(wired.frame, {
      events: wiredEvents.events,
      resourceUri: "ui://card/1",
      onCallTool: () => Promise.resolve({ content: [] }),
    });
    wiredEvents.emit(INITIALIZE, wired.contentWindow);
    expect(wired.posted[0]?.message.result?.["hostCapabilities"]).toEqual({ serverTools: {} });

    // A hook WITHOUT a resourceUri is not a wired relay — nothing to scope
    // the calls to, so neither the capability nor the machine's relay arms.
    const unscoped = fakeFrame();
    const unscopedEvents = fakeEvents();
    attachViewHost(unscoped.frame, {
      events: unscopedEvents.events,
      onCallTool: () => Promise.resolve({ content: [] }),
    });
    unscopedEvents.emit(INITIALIZE, unscoped.contentWindow);
    expect(unscoped.posted[0]?.message.result?.["hostCapabilities"]).toEqual({});
  });

  it("explicit hostCapabilities win over the derived serverTools", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, {
      events,
      resourceUri: "ui://card/1",
      onCallTool: () => Promise.resolve({ content: [] }),
      hostCapabilities: { serverTools: { listChanged: true } },
    });
    emit(INITIALIZE, contentWindow);
    expect(posted[0]?.message.result?.["hostCapabilities"]).toEqual({
      serverTools: { listChanged: true },
    });
  });

  it("detach stops listening, clears the timer, and posts the teardown farewell through the cached window", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit, listenerCount } = fakeEvents();
    const phases: ViewHostPhase[] = [];
    const detach = attachViewHost(frame, {
      events,
      negotiationTimeoutMs: 100,
      onPhaseChange: (p) => phases.push(p),
    });
    expect(listenerCount()).toBe(1);

    detach();

    expect(listenerCount()).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      method: "ui/resource-teardown",
      params: {},
    });
    vi.advanceTimersByTime(1000);
    expect(phases).toEqual([]);
    emit(INITIALIZE, contentWindow);
    expect(posted).toHaveLength(1);
  });
});

describe("viewDocumentHtml", () => {
  it("prefers text verbatim", () => {
    expect(viewDocumentHtml({ uri: "ui://x", text: "<p>hi</p>" })).toBe("<p>hi</p>");
  });

  it("decodes a blob as base64 UTF-8", () => {
    const html = "<p>안녕 ✓</p>";
    const blob = Buffer.from(html, "utf-8").toString("base64");
    expect(viewDocumentHtml({ uri: "ui://x", blob })).toBe(html);
  });

  it("is undefined when the payload carries no document", () => {
    expect(viewDocumentHtml({ uri: "ui://x" })).toBeUndefined();
  });

  it("treats malformed base64 as no-document, never a render-time throw", () => {
    expect(viewDocumentHtml({ uri: "ui://x", blob: "%%not-base64%%" })).toBeUndefined();
  });
});
