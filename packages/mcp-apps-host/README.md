# @guuey/mcp-apps-host

The **Host** role of [MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps)
for guuey's chat surfaces — and for any host that mounts MCP Apps views.

The spec's constant refrain is "Host MUST …". This package implements that
role's client-side narrowing and mount contract:

- **View-mount dispatch** (`toolResultViewMount`, `snapshotViewMount`): one
  narrowing that answers "what, if anything, does this block mount?" across
  the UI channels a transcript carries — an inline `ui://` resource payload,
  a vendor fast-path (ggui's render shell, until its retirement per the
  conformance map), or a bare `ui://` **locator**.
- **Locator rehydration**: a persisted `ui://` locator remounts by a fresh,
  authenticated `resources/read` of the uri — the spec-consistent template
  fetch (the spec itself defers persistence/restoration; a full remount
  additionally owes the View `ui/notifications/tool-input` + its tool
  result) — never by replaying stored mount material. The read transport is injected
  (`UiResourceReader`); the host owns auth and user-ownership enforcement,
  and a deny is byte-identical to a miss.
- **Sandbox-trust channels** (`ViewMountChannel`): which sandbox host page a
  payload may mount in, until per-resource declared-CSP construction lands.

Vendor-neutral by principle: ggui's MCP Apps run on any spec-following host
(claude.ai, chatgpt.com, guuey) precisely because they follow the spec; this
package is guuey's OSS host-side support for the same spec.

Conformance status and roadmap: `docs/development/mcp-apps-host-conformance.md`
in the guuey monorepo (guuey#123).
