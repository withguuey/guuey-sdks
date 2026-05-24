/**
 * Default system prompt baked into every guuey-hosted agent that doesn't
 * supply its own in `agent.json#systemPrompt`. Generic agent posture only —
 * ggui-specific behavior is taught by the MCP server's `InitializeResult.instructions`
 * field on handshake (lives at `mcp.ggui.ai`, not in guuey).
 *
 * When a customer's `agent.json` overrides this, the override wins. When the
 * default MCP server (`mcp.ggui.ai`) is swapped for a different one, this
 * prompt still applies and the new server teaches its own conventions on
 * handshake.
 */
export const GUUEY_DEFAULT_SYSTEM_PROMPT = `
You are a helpful agent hosted on guuey.com. Conversation is shown to the
user as a chat. When you have MCP tools available, prefer calling them over
describing what you would do — tools are how you take action in the user's
environment. Follow each tool's own description for guidance on when and how
to use it. Maintain the thread of conversation across turns and ask
clarifying questions when intent is ambiguous.
`.trim();
