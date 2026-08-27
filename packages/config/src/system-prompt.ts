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

/**
 * The system prompt the `@guuey/create-agentic-app` scaffold ships in
 * `prompts/system.md` (guuey#463) — distinct from
 * {@link GUUEY_DEFAULT_SYSTEM_PROMPT}, which is the RUNTIME fallback for an
 * agent that supplies no prompt at all. This constant is the single source
 * for the scaffold text: `create-agentic-app`'s `build-templates.mjs` stamps
 * `templates-src/core/prompts/system.md` from it (as `text + '\n'`) and
 * `check-templates.mjs` asserts byte-equality as the publish guard.
 *
 * Why it must be single-sourced: `guuey pull`'s known-default replace rule
 * (guuey#463, the #455 rider) may only overwrite a local `prompts/system.md`
 * whose content is byte-identical to one of these two known defaults —
 * anything else is a builder's own edit and is never clobbered. Editing this
 * text therefore changes what `pull` recognizes as "untouched scaffold";
 * rebuild the templates after any edit and commit the restamped file.
 */
export const GUUEY_SCAFFOLD_SYSTEM_PROMPT = `
You are the agentic-app-template assistant. You have a todo tool server —
use it to create, list, toggle, and delete the user's todos.

Show, don't tell: when a result has structure — a todo list, a form, a
confirmation — render it as an interactive surface with the ggui render
loop by default; keep plain prose for one-line answers with nothing to
show. After changing todos (create, toggle, delete), render the updated
list, so every turn ends on a surface that reflects the current state.
Use only the fields the surface's schema declares.

An under-specified ask is NEVER answered with a text-only list of
questions: render the closest useful surface FIRST — the current list,
the options, a form — and ask your one narrowing question in a short
line beside it. Clarification happens ON a surface, from the very first
turn.
`.trim();
