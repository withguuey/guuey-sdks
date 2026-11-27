# @guuey/worker

The Guuey Worker Protocol v1 types + the tiered worker SDK. Write an agent worker
for Guuey with any Node framework. With the Claude Agent SDK, the OpenAI Agents
SDK or Google's ADK you get tool cards, and any other framework can stream text
answers, with history, when it calls Claude through Guuey (leave `framework`
unset). Guuey runs it, isolates it per end-user,
streams it, and scales it. You touch only: **read the request → stream your output (text or framework-native events).**

## Zero glue — managed Node base (1a)

Export a handler; the base harness wires it to the protocol.

```js
import { query } from "@anthropic-ai/claude-agent-sdk";
export default async (turn) => {
  for await (const msg of query({ prompt: turn.input, options: {} })) {
    if (msg.type === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") turn.text(block.text);
      }
    }
  }
};
```

## Raw, no SDK

Guuey hosts Node workers today. The Python example below shows the wire format only.

The protocol is deliberately hand-implementable: read NDJSON control messages on
**stdin (fd 0)**, write NDJSON events on **fd 3**, log freely on stdout/stderr.

```python
import sys, json, os
for line in sys.stdin:
    inv = json.loads(line)   # {type:"invoke", input, identity, fs, history, priorMemory?, priorState?, mcpAvailability?}
    if inv.get("type") != "invoke": continue
    # emit framework-native SDK events (the Router normalizes them):
    os.write(3, (json.dumps({"type":"native","framework":"google-adk","event":{...}}) + "\n").encode())
    os.write(3, (json.dumps({"type":"done","stopReason":"end_turn","result":"hi"}) + "\n").encode())
```

## The protocol (v1)

- **fd 0 (stdin), Router→Worker:** `invoke` · `shutdown`
- **fd 3, Worker→Router:** `text` · `native` · `done` · `error`
- **stdout/stderr:** your logs — never the protocol.
- Context is **pushed** in the invoke (`history` · `priorMemory` · `priorState` · `mcpAvailability` — per OAuth-connected server, whether its tools are available this turn; guuey#901).

See the design: `docs/superpowers/specs/2026-06-22-worker-platform-northstar-design.md`.

## Turn content: context and files

An invoke can carry more than the person's text. The worker's content helpers (`anthropicUserContent`,
`openaiTurnInput`, `geminiUserParts`) turn it into model content, so the framing, order and escaping are the
platform's own:

- **Session context** (`invoke.sessionContext`): data your app's server set for the whole conversation. It is framed
  as `<session_context>` and stays in effect until a later one replaces or clears it.
- **Turn context** (`invoke.turnContext`): data your app attached to this one message. It is framed as
  `<message_context>`: the person's data, not an instruction.
- **Parts** (`invoke.parts`): audio, files and documents the person sent. Images stay on `invoke.attachments`. A
  part goes to the model as its own content when that model API takes the type. Otherwise it is saved in the
  conversation's storage, and one `<message_files>` note names each file, so nothing is dropped in silence. When
  the agent has no tool that opens a file's type, the note says so, and the model tells the person.

Both frames and the files note come before the person's own text, and the person's text is escaped so it can never
pass for one of them. Set `context: true` and `parts: { target, fileTools }` in `serveNative`'s options, and each
hello says which context the invoke carried and, for each part, whether it went `native`, as a `file` the agent can
open, or `file-unreadable`. The protocol stays v1: older workers simply ignore the new fields.

## Support

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
