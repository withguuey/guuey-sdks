/**
 * The page side of the native MCP Apps frame: the shim injected into the
 * WebView before the view's own scripts run, the script that delivers one
 * host message into the page, and the parse of what the page posts back.
 *
 * Derived from `src/components/mcp-apps-bridge.ts` and `mintBridgeNonce` in
 * `src/McpAppIframe/McpAppIframe.tsx` of `@ggui-ai/mcp-apps-react-native`
 * 0.29.0 (https://github.com/ggui-ai/ggui, `packages/mcp-apps-react-native`),
 * Copyright ggui contributors, licensed under the Apache License, Version 2.0
 * (see LICENSE-APACHE-2.0 in this package). Changed for
 * guuey: the JSON-RPC dispatcher is removed (the host machine in
 * `@guuey/mcp-apps-host` answers the view), the envelope key and page globals
 * are renamed from `ggui` to `guuey`, and the envelope parse is new.
 *
 * Why a shim at all: an MCP App is written for an iframe and posts to
 * `window.parent`. In a top-level WebView `window.parent === window`, so the
 * shim aliases `window.parent.postMessage` (and `window.postMessage`) onto
 * the native handler, and gives the page ONE stable parent object so a view
 * that checks `event.source === window.parent` still matches.
 *
 * Why a nonce: the native handler (`ReactNativeWebView.postMessage`) is
 * reachable from every frame in the WebView, while this shim runs in the main
 * frame only. Each mounted frame mints a nonce, the shim keeps it in its
 * closure (never on `window`) and stamps it on every envelope, and the host
 * drops every envelope without it: a nested frame cannot speak to the host
 * directly.
 */

/** The envelope key the shim wraps every page → host message in. */
export const NATIVE_BRIDGE_ENVELOPE_KEY = "__guuey_mcp_apps";

/**
 * A per-mount nonce: `crypto.getRandomValues` when the runtime has it (Hermes
 * does), else `crypto.randomUUID`, else two `Math.random` segments. The host
 * drops a wrong nonce silently, so a stranger has no oracle.
 */
export function mintBridgeNonce(): string {
  const g: {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array; randomUUID?: () => string };
  } = globalThis;
  if (g.crypto?.getRandomValues) {
    const bytes = g.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().replace(/-/g, "");
  const seg = (): string => Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return seg() + seg();
}

/**
 * The script injected before the page's own scripts
 * (`injectedJavaScriptBeforeContentLoaded`). The `true;` trailer is required
 * by react-native-webview on iOS for injected strings.
 */
export function buildInjectedBridgeScript(nonce: string): string {
  const nonceLiteral = JSON.stringify(nonce);
  const keyLiteral = JSON.stringify(NATIVE_BRIDGE_ENVELOPE_KEY);
  return `
(function() {
  try {
    if (window.__guueyMcpAppsBridge) return;
    window.__guueyMcpAppsBridge = { version: 1 };

    // The native post function, captured NOW, before any card script runs:
    // a card that later wraps window.ReactNativeWebView.postMessage never
    // sees an envelope (so never the nonce). Looked up once more on first
    // use only if the native bridge was not yet installed at this point.
    var nativePost = null;
    function captureNativePost() {
      var rn = window.ReactNativeWebView;
      if (rn && typeof rn.postMessage === 'function') nativePost = rn.postMessage.bind(rn);
    }
    captureNativePost();

    function forward(msg) {
      try {
        if (nativePost === null) captureNativePost();
        if (nativePost === null) return;
        var envelope = { nonce: ${nonceLiteral}, payload: msg };
        envelope[${keyLiteral}] = true;
        nativePost(JSON.stringify(envelope));
      } catch (_e) {}
    }

    // Page -> host. In a top-level WebView window.parent === window, so an
    // iframe-shaped view's window.parent.postMessage lands on
    // window.postMessage: forward it instead of firing a same-window event.
    window.postMessage = function(data) {
      forward(data);
    };
    // ONE stable parent object: a getter minting a fresh object per read
    // breaks every view that checks event.source === window.parent.
    var parentProxy = { postMessage: forward };
    try {
      Object.defineProperty(window, 'parent', {
        configurable: true,
        get: function() {
          return parentProxy;
        },
      });
    } catch (_e) {
      // A non-configurable parent: the window.postMessage override above
      // still covers the window.parent === window loopback.
    }

    // Host -> page. WebKit rejects a synthesized MessageEvent whose source
    // is a plain object, so the shim captures 'message' listeners at
    // document start and delivers by direct call with an event-shaped
    // object whose source IS the stable parent object.
    var messageListeners = [];
    var origAdd = window.addEventListener ? window.addEventListener.bind(window) : null;
    window.addEventListener = function(type, fn, opts) {
      if (type === 'message' && typeof fn === 'function') messageListeners.push(fn);
      if (origAdd) return origAdd(type, fn, opts);
    };
    var origRemove = window.removeEventListener ? window.removeEventListener.bind(window) : null;
    window.removeEventListener = function(type, fn, opts) {
      if (type === 'message') {
        var i = messageListeners.indexOf(fn);
        if (i !== -1) messageListeners.splice(i, 1);
      }
      if (origRemove) return origRemove(type, fn, opts);
    };
    window.__guueyDeliver = function(data) {
      var ev = { type: 'message', data: data, source: parentProxy, origin: '' };
      var snapshot = messageListeners.slice();
      for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i](ev); } catch (_e) {}
      }
      if (typeof window.onmessage === 'function') {
        try { window.onmessage(ev); } catch (_e) {}
      }
    };

    window.__guueyMcpAppsBridge.ready = true;
  } catch (_e) {}
})();
true;
`;
}

/**
 * The script that delivers one host message into the page. The message is
 * JSON-encoded twice, so every caller-controlled string lands inside a
 * `JSON.parse`d string literal, never as script; U+2028 and U+2029 are
 * escaped on top, since an engine older than ES2019 ends a string literal at
 * either. Falls back to a `MessageEvent` (no `source`) only when the shim
 * failed to install.
 */
export function buildDeliveryScript(message: unknown): string {
  const json = JSON.stringify(JSON.stringify(message)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `
(function() {
  try {
    var data = JSON.parse(${json});
    if (typeof window.__guueyDeliver === 'function') {
      window.__guueyDeliver(data);
    } else {
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    }
  } catch (_e) {}
})();
true;
`;
}

/**
 * The page's payload from one native message, or `undefined` when it is not
 * this mount's traffic: not JSON, not an envelope, or not stamped with
 * `nonce`. Dropped silently, so a stranger learns nothing.
 */
export function readBridgeEnvelope(raw: string, nonce: string): { payload: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (Reflect.get(parsed, NATIVE_BRIDGE_ENVELOPE_KEY) !== true) return undefined;
  if (Reflect.get(parsed, "nonce") !== nonce) return undefined;
  return { payload: Reflect.get(parsed, "payload") };
}
