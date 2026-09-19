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

Everything is optional both ways across a rolling release: a `guuey.json`
without `hooks` behaves exactly as before.
