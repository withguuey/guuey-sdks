/**
 * The MCP tool-result side-channel for `@openai/agents` (guuey#981).
 *
 * The Agents SDK flattens an MCP tool result to model-visible text; the ONLY
 * channel that carries the result's `structuredContent` and `_meta` onto the
 * wire (`item.customData`) without leaking them into model-visible text is
 * `MCPServer.customDataExtractor` (agents 0.12+). The card's `ui://` locator
 * rides exactly there (MCP-Apps: `_meta.ui` + the surface `structuredContent`),
 * and so does the ggui render-cache marker (`structuredContent.cache.hit`).
 *
 * One implementation for every OpenAI worker — the code-mode template's
 * `worker.ts` AND `@guuey/host`'s adapter. Before this, the template built its
 * `MCPServerStreamableHttp` with no extractor, so on every code-mode
 * openai-agents-sdk app the render result reached the pod without a locator:
 * `✓ ggui render`, no card, and render metering blind (prod, 2026-09-07).
 *
 * Structural parameter type on purpose: `@guuey/worker` takes no dependency
 * on `@openai/agents`; the SDK's `MCPToolCustomDataContext` satisfies it by
 * width (`structuredContent?`, `resultMeta?`).
 */
export interface McpToolCustomDataContext {
  /** MCP tool result `structuredContent`, if present. */
  structuredContent?: Record<string, unknown> | undefined;
  /** MCP tool result `_meta`, if present (the SDK names it `resultMeta`). */
  resultMeta?: Record<string, unknown> | undefined;
}

/**
 * A `type` (not an `interface`) on purpose: the SDK's extractor return type
 * is index-signature-shaped, and only object-literal types carry the implicit
 * index signature that makes this assignable without a cast.
 */
export type McpToolCustomData = {
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** `customDataExtractor` for every OpenAI MCP server: structuredContent + `_meta`, or nothing. */
export function mcpToolCustomData(context: McpToolCustomDataContext): McpToolCustomData | undefined {
  const out: McpToolCustomData = {
    ...(context.structuredContent !== undefined ? { structuredContent: context.structuredContent } : {}),
    ...(context.resultMeta !== undefined ? { _meta: context.resultMeta } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}
