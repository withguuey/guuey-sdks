#!/usr/bin/env node
// Silver-protocol fixture worker: replays REAL captured Claude Agent SDK
// `SDKMessage`s (copied verbatim from
// `../silverprotocol/sdks/typescript/packages/e2e/corpus/echo-sonnet5/claude.native.json`
// entries [3] and [4] — the assistant text turn + its `result` message) as
// `native` events, so `dev-server.test.ts` exercises the REAL
// `createClaudeNormalizer()` facet end-to-end instead of a synthetic shape.
import { createInterface } from "node:readline";
import { createWriteStream } from "node:fs";
const fd3 = createWriteStream("", { fd: 3 });
const emit = (o) => fd3.write(JSON.stringify(o) + "\n");

// Verbatim capture — see corpus path above.
const ASSISTANT_TEXT = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5",
    id: "msg_01M69QMmKcYQuRUKPQ4KY9hC",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "The tool returned: **conformance-probe-sonnet5**" }],
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 743,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      output_tokens: 1,
      service_tier: "standard",
      inference_geo: "global",
    },
    diagnostics: null,
    context_management: null,
  },
  parent_tool_use_id: null,
  session_id: "2a6a0505-b983-42f1-aacc-38ba3c445cb5",
  uuid: "d7570262-f7fa-42b6-a984-27307ddb4f20",
  request_id: "req_011CcePX9m6sNhP5TQz6n7uh",
};

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  duration_ms: 4048,
  duration_api_ms: 4806,
  ttft_ms: 2997,
  ttft_stream_ms: 2920,
  time_to_request_ms: 192,
  num_turns: 2,
  result: "The tool returned: **conformance-probe-sonnet5**",
  stop_reason: "end_turn",
  session_id: "2a6a0505-b983-42f1-aacc-38ba3c445cb5",
  total_cost_usd: 0.006096,
  usage: {
    input_tokens: 1406,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 85,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard",
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: "global",
    iterations: [],
    speed: "standard",
  },
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 538,
      outputTokens: 13,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.000603,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
    "claude-sonnet-5": {
      inputTokens: 1406,
      outputTokens: 85,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.005493,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
    },
  },
  permission_denials: [],
  uuid: "fb1b055b-45cf-41d5-8808-0bb02f80bf5b",
};

for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.type === "shutdown") process.exit(0);
  if (msg.type !== "invoke") continue;
  emit({ type: "hello", framework: "claude-agent-sdk", sdkName: "@anthropic-ai/claude-agent-sdk", sdkVersion: "0.3.199" });
  emit({ type: "native", framework: "claude-agent-sdk", event: ASSISTANT_TEXT });
  emit({ type: "native", framework: "claude-agent-sdk", event: RESULT });
  emit({ type: "done", stopReason: "end_turn", result: RESULT.result });
}
