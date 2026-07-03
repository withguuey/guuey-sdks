/**
 * MCP-Apps sandbox proxy for local dev — a Vite plugin that serves the
 * spec-canonical `sandbox.html` on a SECOND localhost port (:6891), i.e. a
 * different origin from the SPA (:6890).
 *
 * # Why a second origin
 *
 * The MCP Apps spec's double-iframe sandbox architecture mandates that the
 * host page and the sandbox iframe live on DIFFERENT origins: the host wraps
 * the sandbox iframe, the sandbox iframe wraps the untrusted app HTML, and
 * the origin split means a compromised app cannot reach the host's APIs via
 * same-origin DOM access. `@mcp-ui/client`'s `<AppRenderer>` takes a
 * `sandbox: { url }` prop pointing at this page. A different localhost PORT
 * is a different origin, so one extra listener is all local dev needs.
 *
 * # Reference impl
 *
 * The HTML below is adapted from the spec's reference host
 * (`github.com/modelcontextprotocol/ext-apps/examples/basic-host/` —
 * sandbox.html + src/sandbox.ts + serve.ts), matching the pattern
 * `@ggui-ai/agent-server`'s bundled sandbox proxy uses. CSP arrives as a
 * `?csp=<urlencoded-json>` query param and is applied via HTTP HEADERS
 * (tamper-proof — a `<meta>` CSP could be overridden by injected inline
 * scripts), which is why this must be a real server, not a static file.
 *
 * # Deploying `web/`
 *
 * This plugin only runs under `vite` dev (`apply: "serve"`). A deployed
 * build must point `VITE_SANDBOX_URL` at a hosted copy of this page on its
 * own origin (see `.env.example`); without it the app falls back to a
 * "UI resource received" notice instead of mounting UI same-origin.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * The sandbox proxy's dev port. web/ runs on :6890; keep the `6891` literal
 * in `src/App.tsx` (`DEV_SANDBOX_URL`) in sync — App.tsx cannot import this
 * module (it would drag `node:http` into the browser bundle).
 */
export const SANDBOX_PROXY_PORT = 6891;

/** CSP shape `<AppRenderer>` forwards on the sandbox URL's `?csp=` param. */
interface McpUiResourceCsp {
  readonly resourceDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

/** Drop CSP entries carrying directive-injection characters (`;`, newlines, quotes, spaces). */
function sanitizeCspDomains(domains: readonly string[] | undefined): readonly string[] {
  if (!domains) return [];
  return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

/** Build the CSP header value — mirrors the upstream basic-host `serve.ts`. */
function buildCspHeader(csp: McpUiResourceCsp | undefined): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ");
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains.length > 0 ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains.length > 0 ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ].join("; ");
}

/**
 * The self-contained sandbox.html. The inlined script:
 *
 *   1. Asserts iframe isolation (throws if it can reach `window.top`).
 *   2. Creates an inner iframe sandboxed with `allow-scripts
 *      allow-same-origin allow-forms`.
 *   3. On `ui/notifications/sandbox-resource-ready` from the parent, writes
 *      the app HTML into the inner iframe.
 *   4. Relays every other postMessage bidirectionally, origin-checked.
 *   5. Posts `ui/notifications/sandbox-proxy-ready` once attached.
 */
const SANDBOX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light dark">
    <title>sandbox proxy</title>
    <style>
      html, body { margin: 0; height: 100vh; height: 100dvh; width: 100%; background-color: transparent; }
      body { display: flex; flex-direction: column; }
      * { box-sizing: border-box; }
      iframe {
        background-color: transparent;
        border: 0px none transparent;
        padding: 0px;
        overflow: hidden;
        flex-grow: 1;
        color-scheme: inherit;
      }
    </style>
  </head>
  <body>
    <script>
(function(){
  'use strict';
  if (window.self === window.top) {
    throw new Error('This file is only to be used in an iframe sandbox.');
  }
  if (!document.referrer) {
    throw new Error('No referrer, cannot validate embedding site.');
  }
  var EXPECTED_HOST_ORIGIN = new URL(document.referrer).origin;
  var OWN_ORIGIN = new URL(window.location.href).origin;
  // Security self-test: top access MUST throw (sandbox attribute strips same-origin).
  try {
    window.top.alert('If you see this, the sandbox is not setup securely.');
    throw 'FAIL';
  } catch (e) {
    if (e === 'FAIL') {
      throw new Error('The sandbox is not setup securely.');
    }
  }
  // Inner iframe — the untrusted app HTML lands here.
  var inner = document.createElement('iframe');
  inner.style = 'width:100%; height:100%; border:none;';
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  document.body.appendChild(inner);
  var RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
  var PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
  window.addEventListener('message', function(event) {
    if (event.source === window.parent) {
      if (event.origin !== EXPECTED_HOST_ORIGIN) {
        console.error('[Sandbox] Rejecting parent message from unexpected origin:', event.origin);
        return;
      }
      if (event.data && event.data.method === RESOURCE_READY) {
        var params = event.data.params || {};
        var html = params.html;
        var sandboxAttr = params.sandbox;
        if (typeof sandboxAttr === 'string') {
          inner.setAttribute('sandbox', sandboxAttr);
        }
        if (typeof html === 'string') {
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document);
          if (doc) {
            doc.open();
            doc.write(html);
            doc.close();
          } else {
            inner.srcdoc = html;
          }
        }
      } else {
        if (inner && inner.contentWindow) {
          inner.contentWindow.postMessage(event.data, '*');
        }
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN) {
        console.error('[Sandbox] Rejecting inner message from unexpected origin:', event.origin);
        return;
      }
      window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
    }
  });
  window.parent.postMessage({
    jsonrpc: '2.0',
    method: PROXY_READY,
    params: {},
  }, EXPECTED_HOST_ORIGIN);
})();
    </script>
  </body>
</html>`;

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://placeholder");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/sandbox.html")) {
    let csp: McpUiResourceCsp | undefined;
    const cspParam = url.searchParams.get("csp");
    if (cspParam !== null) {
      try {
        const parsed: unknown = JSON.parse(cspParam);
        if (parsed !== null && typeof parsed === "object") {
          csp = parsed as McpUiResourceCsp;
        }
      } catch {
        // Malformed ?csp= — fall through to the default (self-only) header;
        // an app loading external resources will surface a CSP violation in
        // the console rather than silently widening the policy.
      }
    }
    res.setHeader("Content-Security-Policy", buildCspHeader(csp));
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.statusCode = 200;
    res.end(SANDBOX_HTML);
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("sandbox proxy: only GET /sandbox.html is served here\n");
}

/**
 * Vite plugin: boot the sandbox proxy alongside `vite` dev, tear it down
 * with it. Dev-only (`apply: "serve"`); deployed builds set
 * `VITE_SANDBOX_URL` instead.
 */
export function sandboxProxyPlugin(): Plugin {
  let server: Server | undefined;
  return {
    name: "agentic-app-template:mcp-apps-sandbox-proxy",
    apply: "serve",
    configureServer(vite) {
      server = createServer(handleRequest);
      server.on("error", (err) => {
        vite.config.logger.error(`[sandbox-proxy] ${String(err)}`);
      });
      server.listen(SANDBOX_PROXY_PORT, "127.0.0.1", () => {
        vite.config.logger.info(
          `  sandbox proxy: http://127.0.0.1:${SANDBOX_PROXY_PORT}/sandbox.html`
        );
      });
      vite.httpServer?.on("close", () => {
        server?.close();
        server = undefined;
      });
    },
  };
}
