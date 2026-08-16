import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachViewHost,
  viewDocumentHtml,
  type ViewCspEvents,
  type ViewFrameLike,
  type ViewHostEvents,
} from "./view-host.js";
import type {
  CspViolationLike,
  ViewCspDiagnosis,
  ViewCspOrigins,
  ViewHostOutbound,
  ViewHostPhase,
} from "./view-host-protocol.js";

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

describe("attachViewHost — resources/read relay", () => {
  const READ = {
    jsonrpc: "2.0",
    id: "r1",
    method: "resources/read",
    params: { uri: "ui://tool/card.html" },
  };

  it("relays through the read hook and posts the spec's ReadResourceResult", async () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const reads: string[] = [];
    attachViewHost(frame, {
      events,
      onReadResource: (uri) => {
        reads.push(uri);
        return Promise.resolve({ uri, mimeType: "text/html", text: "<p>fresh</p>" });
      },
    });
    emit(READ, contentWindow);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(reads).toEqual(["ui://tool/card.html"]);
    expect(posted[0]?.message).toEqual({
      jsonrpc: "2.0",
      id: "r1",
      result: {
        contents: [{ uri: "ui://tool/card.html", mimeType: "text/html", text: "<p>fresh</p>" }],
      },
    });
  });

  it("answers a miss AND a throwing hook with the one not-found error — never a hang", async () => {
    for (const hook of [
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("embedder bug")),
    ]) {
      const { frame, posted, contentWindow } = fakeFrame();
      const { events, emit } = fakeEvents();
      attachViewHost(frame, { events, onReadResource: hook });
      emit(READ, contentWindow);
      await vi.waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]?.message.error?.code).toBe(-32002);
    }
  });

  it("re-narrows at runtime: an entry with neither text nor blob is a miss", async () => {
    // Host hooks may be plain JS — the annotation is not trusted (the
    // createMcpUiResourceReader discipline, reader.test.ts).
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, {
      events,
      onReadResource: () => Promise.resolve({ uri: "ui://tool/card.html" }),
    });
    emit(READ, contentWindow);
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.message.error?.code).toBe(-32002);
  });

  it("advertises serverResources automatically when (and only when) the read hook is wired", () => {
    const wired = fakeFrame();
    const wiredEvents = fakeEvents();
    attachViewHost(wired.frame, {
      events: wiredEvents.events,
      onReadResource: () => Promise.resolve(undefined),
    });
    wiredEvents.emit(INITIALIZE, wired.contentWindow);
    expect(wired.posted[0]?.message.result?.["hostCapabilities"]).toEqual({ serverResources: {} });

    const unwired = fakeFrame();
    const unwiredEvents = fakeEvents();
    attachViewHost(unwired.frame, { events: unwiredEvents.events });
    unwiredEvents.emit(INITIALIZE, unwired.contentWindow);
    expect(unwired.posted[0]?.message.result?.["hostCapabilities"]).toEqual({});
  });
});

describe("attachViewHost — size-changed", () => {
  it("forwards the view's size report to onSizeChanged", () => {
    const { frame, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    const sizes: { width?: number; height?: number }[] = [];
    attachViewHost(frame, { events, onSizeChanged: (size) => sizes.push(size) });
    emit(
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } },
      contentWindow,
    );
    expect(sizes).toEqual([{ height: 420 }]);
  });

  it("a size report with no observer is consumed silently — additive by construction", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachViewHost(frame, { events });
    emit(
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } },
      contentWindow,
    );
    expect(posted).toEqual([]); // no answer owed to a notification
  });
});

// The CSP tripwire (guuey#235), through its injectable seam. The pure
// verdict is pinned in view-host-protocol.test.ts; this pins the WIRING:
// armed only with cspOrigins, first matching violation reported once,
// removed on detach, inert for callers that never opt in.
function fakeCspEvents(): {
  cspEvents: ViewCspEvents;
  violate: (v: CspViolationLike) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(event: CspViolationLike) => void>();
  return {
    cspEvents: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    violate: (v) => {
      for (const listener of [...listeners]) listener(v);
    },
    listenerCount: () => listeners.size,
  };
}

const VIEW_ORIGINS: ViewCspOrigins = {
  resourceDomains: ["https://assets.mcp.example"],
  connectDomains: ["https://mcp.example", "wss://mcp.example"],
};

describe("attachViewHost — the CSP tripwire (guuey#235)", () => {
  it("installs no listener without cspOrigins — zero behavior change for existing callers", () => {
    const { frame } = fakeFrame();
    const { events } = fakeEvents();
    const { cspEvents, listenerCount } = fakeCspEvents();
    const detach = attachViewHost(frame, { events, cspEvents });
    expect(listenerCount()).toBe(0);
    detach();
  });

  it("reports the first violation ABOUT the view once, with the actionable allowance", () => {
    const { frame } = fakeFrame();
    const { events } = fakeEvents();
    const { cspEvents, violate, listenerCount } = fakeCspEvents();
    const diagnoses: ViewCspDiagnosis[] = [];
    const detach = attachViewHost(frame, {
      events,
      cspEvents,
      cspOrigins: VIEW_ORIGINS,
      onCspDiagnosis: (d) => diagnoses.push(d),
    });
    expect(listenerCount()).toBe(1);
    // Not the view's: a bare policy token (the zod eval probe of guuey#236)
    // and some unrelated third-party script.
    violate({ blockedURI: "eval", violatedDirective: "script-src" });
    violate({ blockedURI: "https://cdn.other.example/x.js", violatedDirective: "script-src-elem" });
    expect(diagnoses).toEqual([]);
    // The view's runtime bundle, refused by script-src-elem.
    violate({
      blockedURI: "https://assets.mcp.example/runtime/v1.js",
      violatedDirective: "script-src-elem",
    });
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]).toMatchObject({
      blockedUri: "https://assets.mcp.example/runtime/v1.js",
      violatedDirective: "script-src-elem",
      suggestedEntry: "https://assets.mcp.example",
    });
    expect(diagnoses[0]?.message).toContain("script-src-elem https://assets.mcp.example");
    // A second matching violation is the same failure repeating — once per attachment.
    violate({ blockedURI: "wss://mcp.example/live", violatedDirective: "connect-src" });
    expect(diagnoses).toHaveLength(1);
    detach();
    expect(listenerCount()).toBe(0);
  });

  it("removes the listener on detach even when nothing ever fired", () => {
    const { frame } = fakeFrame();
    const { events } = fakeEvents();
    const { cspEvents, listenerCount } = fakeCspEvents();
    const detach = attachViewHost(frame, { events, cspEvents, cspOrigins: VIEW_ORIGINS });
    expect(listenerCount()).toBe(1);
    detach();
    expect(listenerCount()).toBe(0);
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
