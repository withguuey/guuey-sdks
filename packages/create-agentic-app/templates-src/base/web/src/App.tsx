/**
 * Minimal-but-real local dev chat client: message list folded from the
 * reducer's `AgReduceResult.messages` (via `useAgentChat`) + an input box.
 * Tool-result blocks that carry an inlined MCP-Apps UI resource (the
 * `_meta.ui.resource` convention landing on `AgBlock.tool-result.uiData` —
 * opaque JSON on the wire, so it's structurally validated below rather than
 * cast) render through `@mcp-ui/client`'s `AppRenderer`, the spec-canonical
 * MCP Apps host.
 *
 * `onCallTool`/`onReadResource` are typed via `ComponentProps<typeof
 * AppRenderer>` instead of importing `@modelcontextprotocol/sdk`'s request
 * types directly — that keeps this file honest against whatever the
 * installed `@mcp-ui/client` version actually expects, with zero guessing.
 *
 * Sandbox origin (MCP Apps spec, double-iframe architecture): the untrusted
 * app HTML must be mounted from a DIFFERENT origin than this page. In dev,
 * `vite.config.ts`'s `sandboxProxyPlugin` serves the spec-canonical
 * `sandbox.html` on :6891 (a different localhost port = a different origin);
 * deployed builds must set `VITE_SANDBOX_URL` to a hosted copy (see
 * `../sandbox-proxy.ts` + `.env.example`). Without a resolvable sandbox URL,
 * UI resources fall back to a visible notice — NEVER a same-origin mount.
 */
import {
  Fragment,
  useCallback,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { AppRenderer } from "@mcp-ui/client";
import type { AgBlock, AgMessage, JsonValue } from "@silverprotocol/core";
import { AGENT_URL, envUrl, useAgentChat } from "./useAgentChat";

type AppRendererProps = ComponentProps<typeof AppRenderer>;
type CallToolHandler = NonNullable<AppRendererProps["onCallTool"]>;
type ReadResourceHandler = NonNullable<AppRendererProps["onReadResource"]>;

/**
 * The dev sandbox proxy served by `vite.config.ts`'s `sandboxProxyPlugin`.
 * The `6891` literal mirrors `SANDBOX_PROXY_PORT` in `../sandbox-proxy.ts`
 * (not imported — that module pulls in `node:http`, which must never enter
 * the browser bundle). Keep the two in sync.
 */
const DEV_SANDBOX_URL = "http://127.0.0.1:6891/sandbox.html";

/**
 * The sandbox origin UI resources mount from. `VITE_SANDBOX_URL` (a deployed
 * copy of the sandbox page on its own origin) wins; in dev the local proxy
 * is the fallback. `undefined` (a production build without the env) shows
 * the plain-text fallback below instead — the untrusted HTML is never
 * mounted same-origin. `envUrl` treats an empty `VITE_SANDBOX_URL=`
 * declaration as unset (it loads as `""`, which would defeat `??` and make
 * `new URL("")` throw mid-render).
 */
const SANDBOX_URL: string | undefined =
  envUrl(import.meta.env.VITE_SANDBOX_URL) ?? (import.meta.env.DEV ? DEV_SANDBOX_URL : undefined);

// ── MCP-embedded-resource narrowing (opaque JsonValue → typed payload) ──────

interface McpUiResourcePayload {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

function isJsonObject(v: JsonValue): v is { [key: string]: JsonValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asResourcePayload(v: JsonValue): McpUiResourcePayload | undefined {
  if (!isJsonObject(v)) return undefined;
  if (typeof v.uri !== "string") return undefined;
  if (typeof v.text !== "string" && typeof v.blob !== "string") return undefined;
  return {
    uri: v.uri,
    ...(typeof v.mimeType === "string" ? { mimeType: v.mimeType } : {}),
    ...(typeof v.text === "string" ? { text: v.text } : {}),
    ...(typeof v.blob === "string" ? { blob: v.blob } : {}),
  };
}

/**
 * Does a tool-result's `uiData` carry an MCP embedded UI resource? Accepts
 * either the resource inlined directly, or wrapped as `{ resource: {...} }`
 * (the shape an MCP `resource` content block carries).
 */
function asUiResource(uiData: JsonValue | undefined): McpUiResourcePayload | undefined {
  if (uiData === undefined || !isJsonObject(uiData)) return undefined;
  const direct = asResourcePayload(uiData);
  if (direct) return direct;
  const nested = uiData.resource;
  return nested !== undefined ? asResourcePayload(nested) : undefined;
}

/**
 * The resource's HTML: inline `text` wins; else base64-decode `blob`.
 * `atob` alone yields a Latin-1 string (mojibake on multibyte UTF-8), so
 * decode via bytes + `TextDecoder`.
 */
function resourceHtml(resource: McpUiResourcePayload): string | undefined {
  if (resource.text !== undefined) return resource.text;
  if (resource.blob !== undefined) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(resource.blob), (c) => c.charCodeAt(0)));
    } catch {
      return undefined; // not valid base64 — treat as no renderable payload
    }
  }
  return undefined;
}

/** The tool name for a tool-result block, read off its paired tool-call block in the same message. */
function toolNameFor(message: AgMessage, toolCallId: string): string {
  const call = message.content.find(
    (b): b is Extract<AgBlock, { type: "tool-call" }> =>
      b.type === "tool-call" && b.toolCallId === toolCallId
  );
  return call?.name ?? "tool";
}

function renderBlock(
  message: AgMessage,
  block: AgBlock,
  handlers: { onCallTool: CallToolHandler; onReadResource: ReadResourceHandler }
): ReactNode {
  switch (block.type) {
    case "text":
      return block.text ? <p className="block block-text">{block.text}</p> : null;
    case "reasoning":
      return block.text ? <p className="block block-reasoning">{block.text}</p> : null;
    case "tool-call":
      return (
        <p className="block block-tool-call">
          → calling <code>{block.name}</code>…
        </p>
      );
    case "tool-result": {
      const resource = asUiResource(block.uiData);
      const html = resource !== undefined ? resourceHtml(resource) : undefined;
      if (html !== undefined) {
        if (SANDBOX_URL === undefined) {
          // No second-origin sandbox available (production build without
          // VITE_SANDBOX_URL). Never mount the untrusted HTML same-origin —
          // degrade to a visible notice instead.
          return (
            <p className="block block-tool-result">
              ← UI resource received — set <code>VITE_SANDBOX_URL</code> to render it (see{" "}
              <code>.env.example</code>).
            </p>
          );
        }
        return (
          <div className="block block-ui-resource">
            <AppRenderer
              key={block.toolCallId}
              toolName={toolNameFor(message, block.toolCallId)}
              sandbox={{ url: new URL(SANDBOX_URL) }}
              html={html}
              onCallTool={handlers.onCallTool}
              onReadResource={handlers.onReadResource}
              onError={(err: unknown) => console.warn("[AppRenderer]", err)}
            />
          </div>
        );
      }
      return (
        <p className={`block block-tool-result${block.isError ? " is-error" : ""}`}>
          ← {block.isError ? "tool error" : "tool result"}
        </p>
      );
    }
    default:
      return null;
  }
}

export function App() {
  const { result, busy, error, needsResync, send } = useAgentChat();
  const [draft, setDraft] = useState("");

  // Neither relay exists in this minimal template — this worker only exposes
  // `POST /agent/invoke` (see useAgentChat.ts), not a general tool-call/
  // resource-read relay. Rendered UI resources that DON'T round-trip through
  // the model (most simple cards/forms) still work; ones that do get a clear
  // error here instead of a silent hang.
  const onCallTool = useCallback<CallToolHandler>(async (params) => {
    throw new Error(
      `tool-call relay is not wired in this template (requested "${params.name}") — ` +
        `add a relay endpoint on your worker for full MCP Apps interactivity.`
    );
  }, []);
  const onReadResource = useCallback<ReadResourceHandler>(async (params) => {
    throw new Error(`resource-read relay is not wired in this template (requested "${params.uri}")`);
  }, []);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text);
  };

  return (
    <div className="app">
      <style>{`
        :root { color-scheme: light dark; }
        body { margin: 0; font-family: system-ui, sans-serif; }
        .app { display: flex; flex-direction: column; height: 100vh; max-width: 720px; margin: 0 auto; }
        header { padding: 12px 16px; border-bottom: 1px solid #8884; }
        header h1 { font-size: 15px; margin: 0; }
        header p { font-size: 12px; opacity: 0.6; margin: 2px 0 0; }
        .history { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
        .empty { opacity: 0.5; font-size: 13px; }
        .message { max-width: 85%; }
        .message-user { align-self: flex-end; text-align: right; }
        .message-assistant, .message-tool { align-self: flex-start; }
        .block { margin: 0; padding: 6px 10px; border-radius: 8px; background: #8882; white-space: pre-wrap; }
        .message-user .block-text { background: #4c8bf522; }
        .block-tool-call, .block-tool-result { font-size: 12px; opacity: 0.7; background: none; padding: 0; }
        .block-tool-result.is-error { color: #d33; }
        .block-ui-resource { padding: 0; background: none; }
        .block-ui-resource iframe { width: 100%; min-height: 240px; border: 1px solid #8884; border-radius: 8px; }
        .banner { margin: 0 16px 8px; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
        .banner-error { background: #d3333322; color: #d33; }
        .banner-warn { background: #d3901922; color: #b8720f; }
        .composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #8884; }
        .composer input { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #8886; }
        .composer button { padding: 8px 14px; border-radius: 6px; border: none; background: #4c8bf5; color: white; }
        .composer button:disabled { opacity: 0.5; }
      `}</style>
      <header>
        <h1>agentic-app-template</h1>
        <p>{AGENT_URL}</p>
      </header>

      <main className="history" role="log" aria-live="polite">
        {result.messages.length === 0 ? (
          <p className="empty">Say something to your agent.</p>
        ) : (
          result.messages.map((message) => (
            <div key={message.id} className={`message message-${message.role}`}>
              {message.content.map((block, i) => (
                <Fragment key={i}>{renderBlock(message, block, { onCallTool, onReadResource })}</Fragment>
              ))}
            </div>
          ))
        )}
      </main>

      {needsResync ? (
        <p className="banner banner-warn">Stream fell out of sync — reload to resync.</p>
      ) : null}
      {error ? <p className="banner banner-error">{error}</p> : null}

      <form className="composer" onSubmit={onSubmit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message your agent…"
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
