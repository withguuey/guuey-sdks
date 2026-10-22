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
jump-to-latest release (a card that grows past the panel settles at its top
instead of being scrolled away by its own growth), windowed rendering for
long transcripts,
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

The head row over a conversation is one component. `<GuueyChat header={{ title,
actions, onClose }}>` draws it; a page that mounts `<Transcript>` with its own
composer renders the same row itself, so both kinds of surface share one
markup and the one `::part(header)` hook:

```tsx
<ChatHeader header={{ title: agentName, actions: <MyStopButton /> }} />
<Transcript plan={plan} … />
```

Outside `<GuueyChat>` the theme is not stamped above the row, so style it
through its class names (`.guuey-chat-header`, `-title`, `-actions`,
`-close`) or set the `--guuey-chat-*` properties on an ancestor.

Server-side (no hook, no DOM): assemble inputs from a persisted thread read
with `transcriptInputsFromHistory` and plan/render anywhere Node runs.

## Owning the scroll (`follow`, `handleRef`, `onAtEndChange`, `jumpToLatest`)

By default `<Transcript>` follows the stream while the reader is at the end. A host that wants
the reader to read an answer while it streams, with the page never moving under their eye,
takes over the scroll. Every prop is optional, and without them nothing changes:

- `follow="off"`: content growth never moves the viewport, and reaching the end by hand does
  not start following.
- `handleRef`: `scrollToItem(key, { align, offset, behavior })`, `scrollToEnd({ behavior })`
  and the scroll `element`. `scrollToItem` returns `false` instead of guessing when the item is
  not rendered.
- `onAtEndChange(atEnd)`: fires as the tail enters and leaves the viewport.
- `jumpToLatest={false}`: hides the built-in chip, for a host that draws its own.

The recipe, which `src/react/transcript-scroll.test.tsx` runs end to end:

```tsx
const handle = useRef<TranscriptHandle>(null);
const [atEnd, setAtEnd] = useState(true);
const lastUserKey = [...plan.items].reverse().find((i) => i.kind === "user")?.key;
useEffect(() => {
  // A new user turn: put it at the top once (offset = your fixed header), then leave the view alone.
  if (lastUserKey !== undefined) handle.current?.scrollToItem(lastUserKey, { align: "top", offset: 56 });
}, [lastUserKey]);

<Transcript plan={plan} follow="off" jumpToLatest={false} handleRef={handle} onAtEndChange={setAtEnd} … />
{!atEnd && <button onClick={() => handle.current?.scrollToEnd({ behavior: "smooth" })}>↓</button>}
```

After the "↓", the transcript follows the stream from the end until the reader scrolls up again.
The handle's core (`scrollToItem`, `scrollToEnd`) is the framework-neutral
`TranscriptScrollHandle` exported from `@guuey/chat`, so other transcript components can
implement the same API.

## Restyling from outside a shadow root (`::part()`)

When `<GuueyChat>` is mounted inside a **shadow root** — the guuey widget's
`transcript: "inline"` mount does this in the host page's own DOM — the
page's stylesheet cannot reach the kit's classes, by design. What it can
reach is a closed set of **CSS Shadow Parts**, stamped as `part`
attributes on the kit's structural elements and exported as `PARTS`:

| Part                                                           | Element                                               |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `surface`                                                      | the outer surface (the theme is stamped here)         |
| `header`                                                       | the header row — present only when `header` is given  |
| `transcript`                                                   | the transcript root                                   |
| `message`, `message user`, `message agent`                     | every message; the visitor's bubble; the agent's text |
| `composer`, `composer-input`, `composer-send`, `composer-stop` | the built-in composer form, its textarea, Send, Stop  |
| `chips`, `chip`                                                | the suggestion row and each chip                      |

```css
/* On the shadow host — the widget's panel carries `guuey-widget-transcript` */
.guuey-widget-transcript::part(message user) {
  background: #0b5cff;
  color: #fff;
}
.guuey-widget-transcript::part(header) {
  display: none;
}
```

The table is closed and pinned by a test (`parts.test.tsx`): names are
added, never renamed. Everything without a `part` is internal and may move.
Light-DOM consumers keep styling by class name; `part` is a hook, never a
selector the kit reads. Pair it with `surface="bare"` when the transcript
should sit directly on the page's own background (no message cards, the
user pill stays a bubble) — the same knob as above, no extra chrome.

## Usage events (`analytics`)

Off by default. With `analytics` on, `<GuueyChat>` hands three usage events
to **your** analytics client — the same vocabulary the guuey widget emits,
stamped `surface: "inline"`:

| Event                 | When                                                                                              | Properties                         |
| --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `helper_opened`       | the first visitor interaction per mount: composer focus, `handle.markOpened()`, or the first turn | `app_id`, `surface`, `gui`         |
| `helper_message_sent` | each visitor turn (composer, `handle.send`, a chip, a card's message); a retry is not a new turn  | `app_id`, `turn`, `surface`, `gui` |
| `helper_cta_clicked`  | a click on a link the chat renders                                                                | `app_id`, `cta`, `surface`, `gui`  |

```tsx
<GuueyChat appId="app_…" endpointUrl={url} analytics />                         // window.posthog, when the page has one
<GuueyChat appId="app_…" endpointUrl={url} analytics={(e, p) => posthog.capture(e, p)} />
<GuueyChat appId="app_…" endpointUrl={url} analytics={{ gguiEnabled: card.gguiEnabled }} />
```

`turn` is a number, never the text. `cta` is the link's `data-cta`, else its
origin and path (never its query or hash; just the scheme for `mailto:` and
`tel:`). `gui` is `"off"` only when you pass `gguiEnabled: false`. Nothing
emits without `appId`. The kit initialises nothing and stores nothing, so your
page's consent setup governs the events. Links inside a card's own sandbox are
not observable from the page and are not counted. A page that feeds the chat
from its own input (`composer={false}`) reports that input's focus with
`handle.markOpened()`.

## React Native adapters (`@guuey/chat/native-adapters`)

`@guuey/chat/native` renders the transcript on React Native. This subpath
supplies the three host pieces a native chat needs beside it, and adds no
dependency: you inject each native module.

- `createNativeAdapters` — the `useAgentInvoke` adapter bundle. The invoke
  stream and the history read go through the `fetch` you pass. Pass a
  streaming one (`expo/fetch`): the platform global buffers the body, so a
  turn would show nothing until its last byte. The thread id persists in the
  storage you pass (AsyncStorage). Identity options match
  `createWebAdapters`; `getGuestSecret` may be async.
- `asyncStorageThreadStore` — that thread-id store on its own.
- `createNativeViewHost` — a `view` slot that mounts cards in the WebView host
  you pass (`McpAppIframe` from `@ggui-ai/mcp-apps-react-native`). It mounts
  inline HTML only, sizes the card from its size reports (clamped), reports
  the view phase, and relays card actions through `onUiAction`, scoped to
  the card.

```tsx
import { fetch } from "expo/fetch";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { McpAppIframe } from "@ggui-ai/mcp-apps-react-native";
import { useAgentInvoke } from "@guuey/agent-client/react";
import { createNativeAdapters, createNativeViewHost } from "@guuey/chat/native-adapters";

const adapters = createNativeAdapters({
  fetch,
  storage: AsyncStorage,
  apiBaseUrl: READ_PLANE_BASE_URL, // ends in /v1; enables history on reload
  getGuestSecret: () => AsyncStorage.getItem("guest-secret"), // 64 lowercase hex
});

// Create once: a new component per render remounts every card.
const view = createNativeViewHost({ McpAppIframe });

function Chat({ endpointUrl, appId }: { endpointUrl: string; appId: string }) {
  const chat = useAgentInvoke({ endpointUrl, appId, adapters });
  // …plan the transcript, then:
  // <NativeTranscript plan={plan} components={{ view }} … />
}
```

Without `onUiAction`, a card's actions are answered in-band as "not
available". Pass `createUiActionRelay(…)` from `@guuey/agent-client` to relay
them.

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
plan.status; // the derived status line ("Getting ready…") or null
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

## Protocol tool rows (`showToolRows`)

`tool.showToolRows` controls which tool calls become transcript rows:

- **`"non-ggui"` (calm default)** — ggui protocol/lifecycle rows are hidden:
  anything in the `ggui_` namespace (`ggui_handshake` / `ggui_render` /
  `ggui_consume`, bare or `mcp__ggui__*`). That narration is machinery, not
  chrome. Two things always stay: the render **card mount** still shows, and a
  **FAILED ggui row stays visible** (a refusal is a real error the visitor
  needs, not chatter). Every non-ggui tool row is unaffected. A ggui render
  mount shows the **card alone**: no `via ggui render` attribution fold either
  (non-ggui tools that mount a view keep theirs).
- **`"all"` (debug default)** — every tool row shows, ggui included.
- **`"none"`** — no tool rows at all.

The wire is unchanged: the pod keeps emitting the tool events; this is
render-side only. Override it like any knob:

```ts
calmPolicy({ tool: { showToolRows: "all" } }); // show the ggui protocol rows too
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

## Support

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
