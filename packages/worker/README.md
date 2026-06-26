# @guuey/worker

The Guuey Worker Protocol v1 types + the tiered worker SDK. Write an agent worker
in any framework; Guuey runs it, isolates it per end-user, streams it, and scales
it. You touch only: **read the request → stream your output (text or framework-native events).**

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

## Raw — any language, no SDK

The protocol is deliberately hand-implementable: read NDJSON control messages on
**stdin (fd 0)**, write NDJSON events on **fd 3**, log freely on stdout/stderr.

```python
import sys, json, os
for line in sys.stdin:
    inv = json.loads(line)   # {type:"invoke", input, identity, fs, history, priorMemory?, priorState?}
    if inv.get("type") != "invoke": continue
    # emit framework-native SDK events (the Router normalizes them):
    os.write(3, (json.dumps({"type":"native","framework":"google-adk","event":{...}}) + "\n").encode())
    os.write(3, (json.dumps({"type":"done","stopReason":"end_turn","result":"hi"}) + "\n").encode())
```

## The protocol (v1)

- **fd 0 (stdin), Router→Worker:** `invoke` · `shutdown`
- **fd 3, Worker→Router:** `text` · `native` · `done` · `error`
- **stdout/stderr:** your logs — never the protocol.
- Context is **pushed** in the invoke (`history` · `priorMemory` · `priorState`).

See the design: `docs/superpowers/specs/2026-06-22-worker-platform-northstar-design.md`.
