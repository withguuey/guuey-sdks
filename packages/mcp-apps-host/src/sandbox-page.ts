/**
 * Sandbox-PAGE document delivery — the client half of the two-origin mount
 * (guuey#135 wave-3c, from the #186/#135 dogfood's finding 2).
 *
 * ## Why a second mount mode exists
 *
 * The default `<GuueyView>` mount is a `srcdoc` frame: zero configuration,
 * opaque origin, correct sandbox posture — but a `srcdoc` document INHERITS
 * the embedding page's Content-Security-Policy, so the strongest egress
 * confinement it can have is whatever the embedder's page happens to carry.
 * Guuey's production surfaces confine harder: the untrusted document mounts
 * inside a HOST-SERVED sandbox page on a second origin, whose per-request
 * CSP names exactly the egress that mount is entitled to (see the platform's
 * `/mcp-app-sandbox` route — per-channel `connect-src`, per-app
 * `frame-ancestors`). This module speaks that page's delivery protocol so
 * any kit consumer can opt into the same confinement.
 *
 * ## The protocol (co-owned in-repo; two notifications)
 *
 * The page is the reference sandbox relay (adapted from the MCP ext-apps
 * `basic-host` example, vendored at
 * `create-agentic-app/templates-src/base/web/sandbox-proxy.ts` and served by
 * the platform's landing route). Its wire is exactly two JSON-RPC
 * notifications:
 *
 *  1. page → host: `ui/notifications/sandbox-proxy-ready` — the relay booted
 *     and is listening;
 *  2. host → page: `ui/notifications/sandbox-resource-ready` with
 *     `params.html` (+ optional `params.sandbox` tokens for the INNER frame —
 *     the page strips `allow-same-origin` from any value regardless).
 *
 * Every other message crosses the page transparently in both directions,
 * which is why `attachViewHost` works unchanged on top of this delivery: the
 * view's `ui/initialize` arrives relayed with `event.source` still the OUTER
 * frame's window, and the host's answers relay inward.
 *
 * ## Identity + targeting
 *
 * Inbound messages are matched by `event.source === frame.contentWindow` —
 * the package's standing identity invariant (`view-host.ts`). Outbound
 * delivery targets `config.pageOrigin` EXPLICITLY (never `'*'`): unlike a
 * srcdoc view, the sandbox page has a real origin, and the document being
 * delivered is agent-generated content the caller confined on purpose — if
 * the frame somehow navigated elsewhere, the browser drops the message
 * instead of handing the document to the wrong receiver.
 */
import type { ViewFrameLike, ViewHostEvents } from "./view-host.js";

export const SANDBOX_PROXY_READY_METHOD = "ui/notifications/sandbox-proxy-ready";
export const SANDBOX_RESOURCE_READY_METHOD = "ui/notifications/sandbox-resource-ready";

/** Structural check for the page's ready notification. */
export function isSandboxProxyReady(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { method?: unknown }).method === SANDBOX_PROXY_READY_METHOD
  );
}

export interface SandboxPageDeliveryConfig {
  /**
   * The sandbox page's origin — the ONLY target the document is posted to.
   * Derive it from the page URL the frame was given (`new URL(url).origin`).
   */
  pageOrigin: string;
  /** The document to deliver (the view's `viewDocumentHtml`). */
  html: string;
  /**
   * Inner-frame sandbox tokens forwarded as `params.sandbox`. The page's
   * `safeSandbox` strips `allow-same-origin` and guarantees `allow-scripts`
   * whatever is sent — this only ever WIDENS within the page's own bounds.
   */
  sandbox?: string;
  /** Message-event source, injectable for tests. Default: `window`. */
  events?: ViewHostEvents;
}

/**
 * Deliver a view document to a mounted sandbox page, re-delivering on every
 * `sandbox-proxy-ready` (a reloaded page announces again and must be
 * re-seeded). Returns a detach function.
 */
export function attachSandboxPageDelivery(
  frame: ViewFrameLike,
  config: SandboxPageDeliveryConfig,
): () => void {
  const deliver = (): void => {
    frame.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: SANDBOX_RESOURCE_READY_METHOD,
        params: {
          html: config.html,
          ...(config.sandbox !== undefined ? { sandbox: config.sandbox } : {}),
        },
      },
      config.pageOrigin,
    );
  };

  const onMessage = (event: { data: unknown; source: unknown }): void => {
    if (frame.contentWindow === null || event.source !== frame.contentWindow) return;
    if (isSandboxProxyReady(event.data)) deliver();
  };

  const { events } = config;
  if (events !== undefined) {
    events.addEventListener("message", onMessage);
    return () => events.removeEventListener("message", onMessage);
  }
  const domListener = (event: MessageEvent): void => onMessage(event);
  window.addEventListener("message", domListener);
  return () => window.removeEventListener("message", domListener);
}
