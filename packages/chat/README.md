# @guuey/chat

The default end-user transcript UI for [guuey](https://guuey.com) agents —
the presentation layer that makes a long, tool-heavy agent turn _readable_:
tool calls collapse into calm one-liners, generative-UI views mount inline,
cold starts and failures are designed states instead of blank screens, and
every unknown block renders as a labeled row (never blank, never raw JSON).

```bash
npm install @guuey/chat
```

## The React kit (`@guuey/chat/react`)

The fastest path on the web — the component kit over the live assembler,
with the default stylesheet:

```tsx
import { useAgentInvoke, createWebAdapters } from "@guuey/agent-client/react";
import { calmPolicy } from "@guuey/chat";
import { Transcript, useTranscript, useTranscriptInputs } from "@guuey/chat/react";
import "@guuey/chat/styles.css";

function Chat({ endpointUrl }: { endpointUrl: string }) {
  const invoke = useAgentInvoke({ endpointUrl, appId: "my-app", adapters: createWebAdapters() });
  const { inputs } = useTranscriptInputs(invoke);
  const { plan, toggle, onViewPhase, resolvedMounts } = useTranscript({
    inputs,
    policy: calmPolicy(),
  });
  return (
    <Transcript
      plan={plan}
      onToggle={toggle}
      onViewPhase={onViewPhase}
      resolvedMounts={resolvedMounts}
    />
  );
}
```

What the kit owns (so you don't): stick-to-bottom scroll with a
jump-to-latest release, windowed rendering for long transcripts,
`aria-live`/keyboard/focus accessibility, sanitized markdown (typed AST —
raw HTML is unrepresentable, links are scheme-allowlisted), generative-UI
views mounting through `@guuey/mcp-apps-host`'s sandboxed host, and theming
from the `GuueyChatTheme` token schema (`GUUEY_CHAT_THEME` ships beside the
neutral default).

**Looking native is the default, not a theming project.** The unthemed kit
is monochrome — ink, no vendor accent — so a zero-config embed disappears
into your product. Two knobs cover most brand work before any theme
exists:

```tsx
<GuueyChat surface="bare" … />    // no message cards — transcript sits on YOUR background
<GuueyChat composer={false} … />  // bring your own input; drive sends via the ref handle
```

The two theming channels **compose** — set any `--guuey-chat-*` CSS custom
property on an ancestor and it wins per-token over the resolved `theme`
prop (the kit stamps its resolved tokens under internal `--_guuey-chat-*`
names and reads `var(--guuey-chat-<t>, var(--_guuey-chat-<t>))`):

```css
.my-app-chat {
  --guuey-chat-accent: var(--brand);
}
```

Override one row without forfeiting the rest:

```tsx
<Transcript plan={plan} components={{ tool: MyToolChip }} … />
```

Server-side (no hook, no DOM): assemble inputs from a persisted thread read
with `transcriptInputsFromHistory` and plan/render anywhere Node runs.

## The headless view-model (the root subpath)

The **headless** half — a pure function from agent state to an ordered
display plan. The root subpath stays React-free forever (the
batteries-included `<GuueyChat>` surface arrives in the next wave).

```ts
import { planTranscript, calmPolicy } from "@guuey/chat";

const plan = planTranscript(
  {
    result: reduceResult, // the @silverprotocol/core Reducer's fold (or null)
    assistantText, // the in-flight turn's cumulative text
    status, // ready | connecting | thinking | using-tool | responding
    statusElapsedMs, // you supply elapsed time — the function has no clock
    activeTool,
    error: null,
    prompts: [],
    messages, // the settled conversation, both roles
  },
  calmPolicy()
);

for (const item of plan.items) {
  // item.kind: "user" | "text" | "tool" | "tool-group" | "view" | "media"
  //          | "code" | "citations" | "prompt" | "error" | "reasoning"
  //          | "data-result" | "history-boundary" | "compaction" | "unknown"
}
plan.status; // the derived status line ("Starting your agent…") or null
```

Determinism contract: same inputs + policy + overrides ⇒ a deeply equal
plan, with **stable item keys** across streaming updates (a tool's key
survives from `running` to `done`), so renderer state and DOM identity hold.

## Presets

`calmPolicy()` is the end-user default: tool runs group into "Ran N tools ▸",
reasoning collapses to a line, results are scroll-capped. `debugPolicy()` is
the builder surface: every tool its own row, args and results expanded, wire
codes verbatim, raw payloads on unknown content.

Both are complete policy bundles — override any knob or any user-facing
string (`ChatStrings`, the i18n seam) without forfeiting the rest:

```ts
calmPolicy({ toolGroup: { threshold: 3 }, strings: { thinking: "Pondering…" } });
```

## Strict-CSP hosts

Generated views boot a runtime and open a live channel to their MCP host;
a page CSP that omits those origins leaves the frame blank. Pass the view's
declared origins via `viewProps={{ cspOrigins: { resourceDomains, connectDomains } }}`
and a policy violation your page incurs on them upgrades the "didn't start"
label into the exact allowance to add. And on a policy without
`'unsafe-eval'`, zod v4 (a dependency) reports one `script-src eval`
violation at boot from its `new Function("")` probe — harmless, but noise
on that same channel; opt out with `z.config({ jitless: true })` in a
side-effect module that is your entry's FIRST import. Full notes on
docs.guuey.com → Chat UI kit → "Strict Content-Security-Policy hosts".

## Theme

`GuueyChatTheme` is a serializable token schema (zod) — the same object a
builder configures on platform.guuey.com. Parsing is lenient and resolution
falls back **per token** to the default theme, so a partial or old-schema
theme can never produce an unreadable surface:

```ts
import { resolveTheme, GUUEY_CHAT_THEME } from "@guuey/chat";
const theme = resolveTheme(appConfiguredTheme); // never throws
```

Two constants ship: the brand-neutral default and `GUUEY_CHAT_THEME` (the
guuey identity — portal's default look).

## The fixture corpus

`src/corpus/` holds the recorded-transcript corpus that DEFINES "comfortably
readable" — forty-tool turns, mid-stream failures, cold starts, dead view
locators, unknown-block storms. The standing rule: a new weird transcript
found in production becomes a fixture before its fix lands. The corpus only
grows.

## Part of the guuey SDK cohort

Consumes [`@guuey/agent-client`](https://www.npmjs.com/package/@guuey/agent-client)
(the invoke stream + fold) and
[`@guuey/mcp-apps-host`](https://www.npmjs.com/package/@guuey/mcp-apps-host)
(the MCP-Apps host role that mounts generative views). Issues:
[withguuey/guuey-sdks](https://github.com/withguuey/guuey-sdks/issues).
