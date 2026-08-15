/**
 * Node coverage for the sandbox-page delivery glue (guuey#135 wave-3c):
 * ready → deliver, re-deliver on a page reload's re-announce, source
 * identity, explicit target origin, sandbox token forwarding, detach.
 */
import { describe, expect, it } from "vitest";
import {
  attachSandboxPageDelivery,
  isSandboxProxyReady,
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
} from "./sandbox-page.js";
import type { ViewHostEvents } from "./view-host.js";

const PAGE_ORIGIN = "https://sandbox.example";
const READY = { jsonrpc: "2.0", method: SANDBOX_PROXY_READY_METHOD, params: {} };

function fakeFrame() {
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string): void {
      posted.push({ message, targetOrigin });
    },
  };
  return { frame: { contentWindow, clientWidth: 100, clientHeight: 100 }, posted, contentWindow };
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

describe("attachSandboxPageDelivery", () => {
  it("delivers the document on the page's ready announce, targeted at the page origin only", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachSandboxPageDelivery(frame, { pageOrigin: PAGE_ORIGIN, html: "<p>card</p>", events });

    expect(posted).toHaveLength(0); // nothing until the page says it's listening
    emit(READY, contentWindow);
    expect(posted).toHaveLength(1);
    expect(posted[0].targetOrigin).toBe(PAGE_ORIGIN);
    expect(posted[0].message).toEqual({
      jsonrpc: "2.0",
      method: SANDBOX_RESOURCE_READY_METHOD,
      params: { html: "<p>card</p>" },
    });
  });

  it("re-delivers when a reloaded page announces again", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachSandboxPageDelivery(frame, { pageOrigin: PAGE_ORIGIN, html: "<p>card</p>", events });
    emit(READY, contentWindow);
    emit(READY, contentWindow);
    expect(posted).toHaveLength(2);
  });

  it("forwards inner-frame sandbox tokens when configured", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachSandboxPageDelivery(frame, {
      pageOrigin: PAGE_ORIGIN,
      html: "<p>card</p>",
      sandbox: "allow-scripts allow-popups",
      events,
    });
    emit(READY, contentWindow);
    expect(posted[0].message).toEqual({
      jsonrpc: "2.0",
      method: SANDBOX_RESOURCE_READY_METHOD,
      params: { html: "<p>card</p>", sandbox: "allow-scripts allow-popups" },
    });
  });

  it("ignores a ready announce from any other source (identity invariant)", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachSandboxPageDelivery(frame, { pageOrigin: PAGE_ORIGIN, html: "<p>card</p>", events });
    emit(READY, { not: "the frame" });
    expect(posted).toHaveLength(0);
    emit(READY, contentWindow);
    expect(posted).toHaveLength(1);
  });

  it("ignores every other message shape (the view-host protocol crosses untouched)", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit } = fakeEvents();
    attachSandboxPageDelivery(frame, { pageOrigin: PAGE_ORIGIN, html: "<p>card</p>", events });
    emit({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, contentWindow);
    emit("not an object", contentWindow);
    emit(null, contentWindow);
    expect(posted).toHaveLength(0);
  });

  it("detach stops listening", () => {
    const { frame, posted, contentWindow } = fakeFrame();
    const { events, emit, listenerCount } = fakeEvents();
    const detach = attachSandboxPageDelivery(frame, {
      pageOrigin: PAGE_ORIGIN,
      html: "<p>card</p>",
      events,
    });
    detach();
    expect(listenerCount()).toBe(0);
    emit(READY, contentWindow);
    expect(posted).toHaveLength(0);
  });
});

describe("isSandboxProxyReady", () => {
  it("matches the notification and nothing else", () => {
    expect(isSandboxProxyReady(READY)).toBe(true);
    expect(isSandboxProxyReady({ method: "ui/initialize" })).toBe(false);
    expect(isSandboxProxyReady([READY])).toBe(false);
    expect(isSandboxProxyReady(null)).toBe(false);
    expect(isSandboxProxyReady("ready")).toBe(false);
  });
});
