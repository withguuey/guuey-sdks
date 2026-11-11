// @vitest-environment jsdom
/**
 * The native MCP Apps frame (guuey#3377), rendered against a FAKE WebView
 * that records its props and every script injected into it. The page side is
 * simulated by posting envelopes through the recorded `onMessage`, exactly
 * as the injected shim would, so the frame's wiring to the host machine is
 * observable without a device. (One run on the real react-native-webview is
 * part of done, in the first host's adoption walk.)
 */
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, useImperativeHandle, type ReactNode, type Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openURL = vi.fn(() => Promise.resolve(true));
vi.mock("react-native", () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return { View: passthrough("div"), Text: passthrough("span"), Linking: { openURL } };
});

const { createMcpAppFrame, isInitialDocumentLoad } = await import("./frame.js");
const { NATIVE_BRIDGE_ENVELOPE_KEY } = await import("./bridge.js");
import type { McpAppWebViewHandle, McpAppWebViewProps } from "./frame.js";
import type { NativeMcpAppFrameProps } from "../view-host.js";

afterEach(cleanup);

interface Recorded {
  props: McpAppWebViewProps | undefined;
  injected: string[];
}

function fakeWebView(rec: Recorded) {
  return function FakeWebView(props: McpAppWebViewProps & { ref?: Ref<McpAppWebViewHandle> }): ReactNode {
    rec.props = props;
    useImperativeHandle(props.ref, () => ({ injectJavaScript: (script: string) => rec.injected.push(script) }), []);
    return createElement("div", { "data-testid": props.testID });
  };
}

/** The data a delivery script hands the page: run it against a page stand-in. */
function delivered(script: string): unknown[] {
  const out: unknown[] = [];
  const page = { __guueyDeliver: (data: unknown) => out.push(data) };
  new Function("window", "MessageEvent", script)(page, class {});
  return out;
}

function nonceOf(rec: Recorded): string {
  const m = /nonce: "([0-9a-z]+)"/.exec(rec.props?.injectedJavaScriptBeforeContentLoaded ?? "");
  if (m?.[1] === undefined) throw new Error("no nonce in the injected shim");
  return m[1];
}

function post(rec: Recorded, payload: unknown, nonce = nonceOf(rec)): void {
  const envelope = { [NATIVE_BRIDGE_ENVELOPE_KEY]: true, nonce, payload };
  act(() => rec.props?.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } }));
}

function mount(over: Partial<NativeMcpAppFrameProps> = {}) {
  const rec: Recorded = { props: undefined, injected: [] };
  const Frame = createMcpAppFrame({ WebView: fakeWebView(rec) });
  const props: NativeMcpAppFrameProps = {
    resource: { uri: "ui://app/card", mimeType: "text/html", text: "<p>card</p>" },
    containerDimensions: { height: 360 },
    onLifecycle: vi.fn(),
    onSizeChanged: vi.fn(),
    onToolCall: vi.fn(() => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }] })),
    onError: vi.fn(),
    ...over,
  };
  const view = render(createElement(Frame, props));
  return { rec, props, view };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "ui/initialize",
  params: { protocolVersion: "2026-01-26", appInfo: { name: "t", version: "1" }, appCapabilities: {} },
};

describe("createMcpAppFrame", () => {
  it("mounts the inline document with the injected shim and the sandbox settings", () => {
    const { rec } = mount();
    expect(rec.props?.source).toEqual({ html: "<p>card</p>" });
    expect(rec.props?.injectedJavaScriptBeforeContentLoaded).toContain("__guueyMcpAppsBridge");
    expect(rec.props).toMatchObject({
      setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      mediaPlaybackRequiresUserAction: true,
      incognito: true,
    });
  });

  it("answers ui/initialize through the host machine and reports the phase as the lifecycle state", () => {
    const { rec, props } = mount();
    post(rec, INITIALIZE);
    const answers = rec.injected.flatMap(delivered);
    expect(answers).toContainEqual(expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.any(Object) }));
    expect(props.onLifecycle).toHaveBeenCalledWith({ state: "connected" });
  });

  it("drops a message without this mount's nonce, or outside the envelope", () => {
    const { rec, props } = mount();
    post(rec, INITIALIZE, "0".repeat(32));
    act(() => rec.props?.onMessage({ nativeEvent: { data: JSON.stringify(INITIALIZE) } }));
    act(() => rec.props?.onMessage({ nativeEvent: { data: "not json" } }));
    expect(rec.injected).toEqual([]);
    expect(props.onLifecycle).not.toHaveBeenCalled();
  });

  it("relays a tools/call to onToolCall and delivers its answer", async () => {
    const { rec, props } = mount();
    post(rec, INITIALIZE);
    post(rec, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh", arguments: { a: 1 } } });
    await act(async () => {});
    expect(props.onToolCall).toHaveBeenCalledWith("refresh", { a: 1 });
    expect(rec.injected.flatMap(delivered)).toContainEqual(
      expect.objectContaining({ id: 2, result: { content: [{ type: "text", text: "ok" }] } }),
    );
  });

  it("reports the app's size-changed notification", () => {
    const { rec, props } = mount();
    post(rec, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } });
    expect(props.onSizeChanged).toHaveBeenCalledWith({ height: 420 });
  });

  it("delivers the spec teardown on unmount", () => {
    const { rec, view } = mount();
    post(rec, INITIALIZE);
    view.unmount();
    expect(rec.injected.flatMap(delivered)).toContainEqual(expect.objectContaining({ method: "ui/resource-teardown" }));
  });

  it("reports a resource with no decodable document and mounts no WebView", () => {
    const { rec, props } = mount({ resource: { uri: "ui://app/card", mimeType: "text/html", blob: "%%%" } });
    expect(props.onError).toHaveBeenCalledWith({ kind: "malformed-resource" });
    expect(rec.props).toBeUndefined();
  });
});

describe("isInitialDocumentLoad", () => {
  it("allows the initial inline document and a card's own sub-frames; refuses a top-frame navigation", () => {
    expect(isInitialDocumentLoad({ url: "about:blank" })).toBe(true);
    expect(isInitialDocumentLoad({ url: "data:text/html;base64,PHA+" })).toBe(true);
    expect(isInitialDocumentLoad({ url: "https://example.com/embed", isTopFrame: false })).toBe(true);
    expect(isInitialDocumentLoad({ url: "https://evil.example/" })).toBe(false);
    expect(isInitialDocumentLoad({ url: "https://evil.example/", isTopFrame: true })).toBe(false);
  });
});

describe("the frame's module", () => {
  it("imports nothing from @ggui-ai/* or react-native-webview", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => !f.includes(".test."))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']@ggui-ai\//);
      expect(source, file).not.toMatch(/from\s+["']react-native-webview["']/);
    }
  });
});
