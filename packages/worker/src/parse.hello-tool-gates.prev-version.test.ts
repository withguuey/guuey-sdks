/**
 * N−1 across a rolling release for the tool-gates.v1 declaration (guuey#2670).
 *
 * - An OLDER Router (its `parseEvent` frozen in `fixtures/parse-event.prev.ts`)
 *   reads a NEWER worker's hello that announces `tool-gates.v1`: it parses, and
 *   no capability the older Router acts on (`adk.host-completion`,
 *   `host.suspend.v1`) reads as announced, so the turn runs as before.
 * - The current parser reads an OLDER worker's hello (the 0.31.1 scaffolds
 *   announce nothing) exactly as the previous parser did, with no
 *   capabilities: a Router reads that as a worker that does not apply the
 *   agent's tool gates.
 */
import { describe, it, expect } from "vitest";
import { readEvent } from "./parse.js";
import { parseEvent as parseEventPrev } from "./fixtures/parse-event.prev.js";
import { createEmitter } from "./emit.js";
import {
  ADK_HOST_COMPLETION_CAPABILITY,
  HOST_SUSPEND_CAPABILITY,
  TOOL_GATES_CAPABILITY,
  type ParsedEvent,
} from "./protocol.js";

/** The hello a 0.31.1 Claude scaffold worker writes: bundled, so its SDK version does not resolve. */
const OLD_CLAUDE_HELLO =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null}';
/** The hello a 0.31.1 OpenAI scaffold worker writes. */
const OLD_OPENAI_HELLO = '{"type":"hello","framework":"openai-agents-sdk","sdkName":"@openai/agents","sdkVersion":null}';
/** The hello a scaffold worker that applies the gates writes, pinned literally. */
const NEW_CLAUDE_HELLO =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null,"capabilities":["tool-gates.v1"]}';
/** The same, on an invoke that also carried a pause offer to a worker that can pause. */
const NEW_HELLO_WITH_SUSPEND =
  '{"type":"hello","framework":"claude-agent-sdk","sdkName":"@anthropic-ai/claude-agent-sdk","sdkVersion":null,"capabilities":["tool-gates.v1","host.suspend.v1"]}';

/** How every Router reads a hello's capability: present only when the list names it. */
function announces(event: ParsedEvent, capability: string): boolean {
  return event.type === "hello" && event.capabilities?.includes(capability) === true;
}

describe("the new hello's bytes", () => {
  it("are what the emitter writes for a worker that applies the gates", () => {
    let bytes = "";
    const emit = createEmitter({ write: (s) => (bytes += s) });
    emit.hello("claude-agent-sdk", "@anthropic-ai/claude-agent-sdk", null, [TOOL_GATES_CAPABILITY]);
    emit.hello("claude-agent-sdk", "@anthropic-ai/claude-agent-sdk", null, [TOOL_GATES_CAPABILITY, HOST_SUSPEND_CAPABILITY]);
    expect(bytes).toBe(`${NEW_CLAUDE_HELLO}\n${NEW_HELLO_WITH_SUSPEND}\n`);
  });
});

describe("the previous Router's readEvent (frozen) × a new worker's hello", () => {
  it("parses it, and differs from the old hello only by the capability list", () => {
    expect(parseEventPrev(NEW_CLAUDE_HELLO)).toEqual({ ...parseEventPrev(OLD_CLAUDE_HELLO), capabilities: ["tool-gates.v1"] });
  });

  it("opens none of the capabilities an older Router acts on", () => {
    const hello = parseEventPrev(NEW_CLAUDE_HELLO);
    expect(announces(hello, ADK_HOST_COMPLETION_CAPABILITY)).toBe(false);
    expect(announces(hello, HOST_SUSPEND_CAPABILITY)).toBe(false);
  });

  it("still reads host.suspend.v1 beside it", () => {
    const hello = parseEventPrev(NEW_HELLO_WITH_SUSPEND);
    expect(announces(hello, HOST_SUSPEND_CAPABILITY)).toBe(true);
    expect(announces(hello, ADK_HOST_COMPLETION_CAPABILITY)).toBe(false);
  });
});

describe("the current readEvent × an old worker's hello", () => {
  it("reads it as the previous parser does, with no capabilities", () => {
    for (const line of [OLD_CLAUDE_HELLO, OLD_OPENAI_HELLO]) {
      const now = readEvent(line);
      expect(now).toEqual(parseEventPrev(line));
      expect("capabilities" in now).toBe(false);
      expect(announces(now, TOOL_GATES_CAPABILITY)).toBe(false);
    }
  });

  it("reads the new hello as announcing tool-gates.v1", () => {
    expect(announces(readEvent(NEW_CLAUDE_HELLO), TOOL_GATES_CAPABILITY)).toBe(true);
    expect(announces(readEvent(NEW_HELLO_WITH_SUSPEND), TOOL_GATES_CAPABILITY)).toBe(true);
  });

  it("reads a malformed capability list as none, so the worker counts as old, never as a refusal", () => {
    for (const capabilities of ["tool-gates.v1", ["tool-gates.v1", 7], null]) {
      const line = JSON.stringify({ ...JSON.parse(OLD_CLAUDE_HELLO), capabilities });
      expect(readEvent(line)).toEqual(parseEventPrev(OLD_CLAUDE_HELLO));
      expect(parseEventPrev(line)).toEqual(parseEventPrev(OLD_CLAUDE_HELLO));
    }
  });
});
