/**
 * The page side of the native MCP Apps frame (guuey#3377): the injected shim,
 * run in a stand-in `window`, and the delivery script, run against a
 * stand-in page. No DOM and no WebView: the scripts are plain functions of
 * `window`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_BRIDGE_ENVELOPE_KEY,
  buildDeliveryScript,
  buildInjectedBridgeScript,
  mintBridgeNonce,
  readBridgeEnvelope,
} from "./bridge.js";

interface PageWindow {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  postMessage?: (data: unknown) => void;
  parent?: { postMessage: (data: unknown) => void };
  addEventListener?: (type: string, fn: (ev: { data: unknown; source: unknown }) => void) => void;
  removeEventListener?: (type: string, fn: (ev: { data: unknown; source: unknown }) => void) => void;
  __guueyDeliver?: (data: unknown) => void;
}

function runShim(page: PageWindow, nonce: string): void {
  new Function("window", buildInjectedBridgeScript(nonce))(page);
}

describe("the injected shim", () => {
  it("forwards window.parent.postMessage to the native handler, stamped with the nonce", () => {
    const native = vi.fn<(data: string) => void>();
    const page: PageWindow = { ReactNativeWebView: { postMessage: native } };
    runShim(page, "n1");
    page.parent?.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(native).toHaveBeenCalledTimes(1);
    const sent = native.mock.calls[0]?.[0] ?? "";
    expect(readBridgeEnvelope(sent, "n1")).toEqual({
      payload: { jsonrpc: "2.0", method: "ui/notifications/initialized" },
    });
  });

  it("gives the page ONE stable parent object", () => {
    const page: PageWindow = { ReactNativeWebView: { postMessage: () => {} } };
    runShim(page, "n1");
    expect(page.parent).toBe(page.parent);
  });

  it("captures the native post function at install: a card that wraps it later never sees an envelope", () => {
    const native = vi.fn<(data: string) => void>();
    const page: PageWindow = { ReactNativeWebView: { postMessage: native } };
    runShim(page, "secret-nonce");
    const spy = vi.fn<(data: string) => void>();
    page.ReactNativeWebView = { postMessage: spy }; // the card's wrapper, installed after the shim
    page.parent?.postMessage({ hello: 1 });
    expect(spy).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("delivers host messages to the page's message listeners with the parent object as source", () => {
    const page: PageWindow = { ReactNativeWebView: { postMessage: () => {} } };
    runShim(page, "n1");
    const seen: { data: unknown; source: unknown }[] = [];
    page.addEventListener?.("message", (ev) => seen.push(ev));
    page.__guueyDeliver?.({ id: 1 });
    expect(seen).toEqual([expect.objectContaining({ data: { id: 1 }, source: page.parent })]);
  });
});

describe("buildDeliveryScript", () => {
  it("round-trips a payload holding line separators, </script>, backslashes and quotes", () => {
    const message = { jsonrpc: "2.0", result: { text: "a b c </script><script>x()</script> \\ \" ' `${1}`" } };
    const script = buildDeliveryScript(message);
    expect(script).not.toContain(" ");
    expect(script).not.toContain(" ");
    const out: unknown[] = [];
    new Function("window", "MessageEvent", script)({ __guueyDeliver: (d: unknown) => out.push(d) }, class {});
    expect(out).toEqual([message]);
  });
});

describe("readBridgeEnvelope", () => {
  it("accepts only this mount's stamped envelopes", () => {
    const ok = JSON.stringify({ [NATIVE_BRIDGE_ENVELOPE_KEY]: true, nonce: "n1", payload: { a: 1 } });
    expect(readBridgeEnvelope(ok, "n1")).toEqual({ payload: { a: 1 } });
    expect(readBridgeEnvelope(ok, "n2")).toBeUndefined();
    expect(readBridgeEnvelope(JSON.stringify({ nonce: "n1", payload: 1 }), "n1")).toBeUndefined();
    expect(readBridgeEnvelope("not json", "n1")).toBeUndefined();
    expect(readBridgeEnvelope("[1]", "n1")).toBeUndefined();
  });
});

describe("mintBridgeNonce", () => {
  it("mints a fresh value each time", () => {
    const a = mintBridgeNonce();
    expect(a).toMatch(/^[0-9a-z]{16,}$/);
    expect(mintBridgeNonce()).not.toBe(a);
  });
});
