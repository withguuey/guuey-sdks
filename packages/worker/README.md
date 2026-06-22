# @guuey/worker

The Guuey Worker Protocol v1 types + the tiered worker SDK. Write an agent worker
in any framework; Guuey runs it, isolates it per end-user, streams it, and scales
it. You touch only: **read the request → stream your output → (optionally) `ask`.**

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

## One line — the SDK

```js
import { serve } from "@guuey/worker";
serve(async (turn) => {
  turn.text(`Hi ${turn.identity.userId}`);
  const tone = await turn.ask("Formal or casual?", { enum: ["formal", "casual"] }); // real HITL
  return `replying in ${String(tone)}`;
});
```

## Raw — any language, no SDK

The protocol is deliberately hand-implementable: read NDJSON control messages on
**stdin (fd 0)**, write NDJSON events on **fd 3**, log freely on stdout/stderr.

```python
import sys, json, os
for line in sys.stdin:
    inv = json.loads(line)               # {type:"invoke", input, identity, fs, history}
    if inv["type"] != "invoke": continue
    os.write(3, (json.dumps({"type":"text","text":"hi"}) + "\n").encode())
    os.write(3, (json.dumps({"type":"done","stopReason":"end_turn","result":"hi"}) + "\n").encode())
```

## The protocol (v1)

- **fd 0 (stdin), Router→Worker:** `invoke` · `answer` · `shutdown`
- **fd 3, Worker→Router:** `text` · `ask` · `done` · `error`
- **stdout/stderr:** your logs — never the protocol.
- Context is **pushed** in the invoke; the full transcript + app config are files
  under `/<layer>/.guuey/`.

See the design: `docs/superpowers/specs/2026-06-22-worker-platform-northstar-design.md`.
