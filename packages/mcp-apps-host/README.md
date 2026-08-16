# @guuey/mcp-apps-host

The **Host** role of [MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps)
for guuey's chat surfaces — and for any host that mounts MCP Apps views.

The spec's constant refrain is "Host MUST …". This package implements that
role's client-side narrowing and mount contract:

- **View-mount dispatch** (`toolResultViewMount`, `snapshotViewMount`): one
  narrowing that answers "what, if anything, does this block mount?" across
  the UI channels a transcript carries — an inline `ui://` resource payload,
  or a bare `ui://` **locator** (from `uiData.resourceUri`, else
  `structuredContent.resourceUri`). Every `ui://` producer, ggui's
  `ggui_render` included, is a locator producer: the ggui vendor fast-path
  retired 2026-08-16 (guuey#209) once the pod's live read door and ggui's
  read-time mint made the spec's read path strictly fresher than any
  inlined bootstrap. Its helpers stay exported one minor as `@deprecated`.
- **Locator rehydration**: a persisted `ui://` locator remounts by a fresh,
  authenticated `resources/read` of the uri — the spec-consistent template
  fetch (the spec itself defers persistence/restoration; a full remount
  additionally owes the View `ui/notifications/tool-input` + its tool
  result) — never by replaying stored mount material. The read transport is injected
  (`UiResourceReader`); the host owns auth and user-ownership enforcement,
  and a deny is byte-identical to a miss.
- **Generic reader assembly** (`createMcpUiResourceReader`): hand it one
  host-owned `resources/read` callable (a raw MCP client, an authenticated
  proxy — no SDK dependency imposed) and get a `UiResourceReader` back, with
  the trust rules built in: deny == miss == placeholder, and the sandbox
  channel derives from the _requested_ locator uri, never the response
  (`uiResourceChannel`). `@guuey/agent-client`'s `createUiResourceReader` is
  this assembly over guuey's platform proxy.
- **Sandbox-trust channels** (`ViewMountChannel`): which sandbox host page a
  payload may mount in, until per-resource declared-CSP construction lands.
- **The host itself** (`attachViewHost`, and `<GuueyView>` from
  `@guuey/mcp-apps-host/react`): a spec-following view opens with the
  `ui/initialize` App handshake and **blocks on it** — mount material alone
  renders a blank frame forever. `attachViewHost(iframe, config)` answers
  that handshake for any embedder (framework-agnostic, one call); the React
  component additionally owns iframe creation, lifecycle, and the safe
  sandbox default (`allow-scripts` **without** `allow-same-origin` — with
  it, agent-generated HTML would run as your origin — plus
  `allow="clipboard-write"` so generated copy buttons work). Configurable
  where a host genuinely varies: `hostCapabilities` (default `{}` —
  advertise only what you implement), an optional `tools/call` relay hook
  (privilege boundary, default off; pair with `createMcpUiActionRelay`),
  `hostContext`, and the negotiation timeout. While a frame negotiates, the
  state is labeled (`negotiating` / `connected` / `no-handshake`), never a
  blank page.
- **Resolved-only mount walk** (`resolveViewMount`): chain it off
  `toolResultViewMount`/`snapshotViewMount` with your reader and render
  only `ResolvedViewMount`s — the locator round-trip is folded in.

Vendor-neutral by principle: ggui's MCP Apps run on any spec-following host
(claude.ai, chatgpt.com, guuey) precisely because they follow the spec; this
package is guuey's OSS host-side support for the same spec.

Conformance status and roadmap: `docs/development/mcp-apps-host-conformance.md`
in the guuey monorepo (guuey#123).
