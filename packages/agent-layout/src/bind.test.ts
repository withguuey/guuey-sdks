/**
 * The GuueyChat bridge, pinned: submit/settled mapping, and the (d)
 * clear firing on live-view GROWTH only — lingering live views from
 * earlier turns and rehydrated history views never clear a fresh
 * submit's pending window.
 */
import { describe, expect, it } from "vitest";
import { bindGuueyChat } from "./bind.js";
import type { AgentModeInput } from "./machine.js";

function harness() {
  const inputs: AgentModeInput["type"][] = [];
  const binding = bindGuueyChat((input) => inputs.push(input.type));
  return { inputs, binding };
}

describe("bindGuueyChat", () => {
  it("submit → agentSubmit, settled → agentSettled", () => {
    const { inputs, binding } = harness();
    binding.onActivity({ type: "submit" });
    binding.onActivity({ type: "settled" });
    expect(inputs).toEqual(["agentSubmit", "agentSettled"]);
  });

  it("a roster change whose live count GREW fires agentViewMounted once", () => {
    const { inputs, binding } = harness();
    binding.onViewsChange([{ key: "a", origin: "live" }]);
    expect(inputs).toEqual(["agentViewMounted"]);
  });

  it("history views and an unchanged live set never fire the clear", () => {
    const { inputs, binding } = harness();
    binding.onViewsChange([{ key: "h1", origin: "history" }]);
    binding.onViewsChange([
      { key: "h1", origin: "history" },
      { key: "h2", origin: "history" },
    ]);
    expect(inputs).toEqual([]);
    // A live view arrives, then the SAME roster re-emits (phase change):
    binding.onViewsChange([{ key: "h1", origin: "history" }, { key: "a", origin: "live" }]);
    binding.onViewsChange([{ key: "h1", origin: "history" }, { key: "a", origin: "live" }]);
    expect(inputs).toEqual(["agentViewMounted"]);
  });

  it("a SHRINK then re-grow fires again (a genuinely new view on the next turn)", () => {
    const { inputs, binding } = harness();
    binding.onViewsChange([{ key: "a", origin: "live" }]);
    binding.onViewsChange([]); // thread reset
    binding.onViewsChange([{ key: "b", origin: "live" }]);
    expect(inputs).toEqual(["agentViewMounted", "agentViewMounted"]);
  });
});
