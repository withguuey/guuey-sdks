/**
 * The from-scratch AgJSON client for the local dev chat SPA. Talks directly
 * to the agent's `POST /agent/invoke` endpoint (SSE response), parses each
 * `event: session|message|done|error` / `data: <JSON>` frame off the wire,
 * and folds `message` frames (AgJSON `AgEvent[]`) through `@silverprotocol/
 * core`'s `Reducer` into the normative `{messages, turns, artifacts, memory}`
 * snapshot `App.tsx` renders from.
 *
 * Real `@silverprotocol/core` API (verified against `core/README.md` +
 * `core/src/reduce.ts:79`): `new Reducer()` + `reducer.push(event)` are
 * correct, but the fold is read back via `reducer.result()` — there is no
 * `reducer.state` accessor. `ingestAgEvents` is the library's own
 * parse-known-else-skip validator; used here instead of an `as AgEvent[]`
 * cast so a malformed/foreign wire object degrades to "silently skipped"
 * rather than a runtime type lie.
 */
import { useCallback, useRef, useState } from "react";
import { Reducer, ingestAgEvents, type AgReduceResult, type JsonValue } from "@silverprotocol/core";

export const AGENT_URL = import.meta.env.VITE_AGENT_ENDPOINT_URL ?? "http://localhost:6790";

/** Parse complete SSE frame blocks ("event: x\ndata: {...}") out of a growing buffer. */
function parseFrames(buffer: string): {
  frames: Array<{ event: string; data: string }>;
  rest: string;
} {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = parts.map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
    return { event, data };
  });
  return { frames, rest };
}

export interface UseAgentChatResult {
  /** The reducer's current folded state — fresh on every `message` frame. */
  result: AgReduceResult;
  /** True while a `send()` request is streaming. */
  busy: boolean;
  /** Last transport/agent error, or `null`. */
  error: string | null;
  /** True when the reducer detected a sequence gap and parked (needs a `messages.snapshot` to recover). */
  needsResync: boolean;
  send: (text: string) => Promise<void>;
}

export function useAgentChat(): UseAgentChatResult {
  const reducerRef = useRef(new Reducer());
  // No payload — just a re-render trigger every time the mutable reducer
  // advances, so `reducerRef.current.result()` below re-derives fresh state.
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (text: string) => {
    setBusy(true);
    setError(null);
    const res = await fetch(`${AGENT_URL}/agent/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok || !res.body) {
      setError(`agent returned ${res.status}`);
      setBusy(false);
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.event === "message") {
          let raw: JsonValue;
          try {
            raw = JSON.parse(frame.data) as JsonValue;
          } catch {
            continue; // malformed frame — skip rather than crash the stream
          }
          const events = ingestAgEvents(Array.isArray(raw) ? raw : []);
          for (const ev of events) reducerRef.current.push(ev);
          bump((v) => v + 1);
        } else if (frame.event === "error") {
          try {
            const payload = JSON.parse(frame.data) as { message?: string };
            setError(payload.message ?? "agent error");
          } catch {
            setError("agent error");
          }
        }
      }
    }
    setBusy(false);
  }, []);

  return {
    result: reducerRef.current.result(),
    busy,
    error,
    needsResync: reducerRef.current.needsResync,
    send,
  };
}
