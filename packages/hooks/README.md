# @guuey/hooks

The guuey **hook spec**: the lifecycle events the platform fires for a hosted
agent, the JSON envelope a hook receives, the result it returns, the two
handler kinds, and the `hooks` block of `guuey.json`.

A hook is **not** code inside the agent. The platform detects the moment (a
conversation went quiet, a visitor asked for a person) and dispatches it; a
hook handler is either an **agent run** inside the app's own session runtime
(`kind: 'agent'` — an instruction, a tool allowlist, the effects that must
happen) or a **direct tool call** (`kind: 'tool'` — one MCP tool, no model).
Prebuilt hooks (`use: 'email-reporter'`) and dev-defined ones share this spec.

```jsonc
// guuey.json → agent.hooks
"hooks": {
  "session.ended":     [ { "use": "email-reporter" } ],
  "handoff.requested": [ { "use": "email-reporter" },
                         { "kind": "tool", "server": "my-crm", "tool": "create_lead" } ],
  "definitions": {
    "nightly-triage": { "kind": "agent", "on": ["session.ended"],
                        "instruction": "…", "tools": ["my-crm.*"], "required": ["my-crm.create_lead"],
                        "model": "small", "maxTurns": 4, "timeoutMs": 60000 }
  }
}
```

## What this package holds

- `HOOK_EVENT_NAMES` / `HookEventName` — the event vocabulary; `HOOK_EVENTS`
  — the per-event table (`class`, `blockable`, `firedInV1`, `allowsAppend`).
  v1 fires `session.ended` and `handoff.requested`; the rest are reserved.
- `hookEventSchema` / `HookEvent` — the envelope the platform sends, a
  discriminated union on `type`.
- `hookResultSchema` / `HookResult` / `HookEffect` — what a hook returns.
  `note` is owner-visible only; `append` reaches the visitor and is allowed
  only on live-session events.
- `hooksSectionSchema` / `HooksSection`, `hookDefinitionSchema`,
  `hookHandlerRefSchema` — the `guuey.json` block, validated by
  `@guuey/config`.
- `toWireToolName('server.tool')` → `mcp__server__tool` — the one function
  both config names and the runtime's tool extractor call.
- An agent definition's `tools` is required and exact: `[]` mounts nothing
  (a summariser that only writes its output); there is no "absent = every
  declared server" default.
- An agent definition's optional `output` is a JSON Schema for the run's
  structured output (the runtime hands it to the model's structured-output
  mode); a `required` tool the model skipped is called with that output.
- `PREBUILT_DEFINITIONS` / `prebuiltBinding(name, event)` — the prebuilt
  catalog, ONE copy for the runtime and the dispatcher, keyed per event.
  `email-reporter`: on `session.ended` an agent run with `tools: []` writes
  the report as its `output` and the platform makes the call — the pod never
  mounts a first-party server for a hook run. On `handoff.requested` it binds
  nothing (`{ kind: 'skip' }`): the platform's notifier already mails every
  hand-off whenever the reporter is on, so a declaration there is legal and
  simply recorded `skipped`.
- `hookInvokeRequestSchema` / `hookInvokeResultSchema` / `HOOK_DOOR_PATH` —
  the wire between the dispatcher and the runtime's hook door
  (`POST <pod origin>/agent/hook`): `{ runId, name, event, timeoutMs }` in,
  `{ runId, status: ok|failed, output?, effects, error? }` out. The pod
  resolves the hook by `name` from its own snapshot or the prebuilt catalog,
  never from the wire.

Everything is optional both ways across a rolling release: a `guuey.json`
without `hooks` behaves exactly as before.

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
