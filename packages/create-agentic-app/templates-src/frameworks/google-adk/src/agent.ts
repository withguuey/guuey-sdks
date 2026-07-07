/**
 * Your agent — pure Google-ADK code. No Guuey SDK, no harness, no event
 * plumbing: export it and the platform runs it (locally via `pnpm dev`,
 * hosted via `guuey deploy`).
 *
 * The default export is a FACTORY receiving everything Guuey resolved for
 * the current turn (`GuueyContext`): the model + instruction from
 * guuey.json, ready-to-use MCP toolsets for every server declared there,
 * the end user's identity, file storage paths, and the conversation state.
 * See the README for the full context tour.
 */
import { FunctionTool, LlmAgent, type MCPToolset } from "@google/adk";
import { z } from "zod";
import type { GuueyContext } from "@guuey/config";

/** A plain ADK tool — everything the ADK offers works unchanged. */
const rollDice = new FunctionTool({
  name: "roll_dice",
  description: "Roll an N-sided die and return the result.",
  parameters: z.object({
    sides: z.number().int().min(2).describe("number of faces on the die"),
  }),
  execute: async ({ sides }) => ({
    result: 1 + Math.floor(Math.random() * sides),
  }),
});

export default (guuey: GuueyContext<MCPToolset>) =>
  new LlmAgent({
    name: "my_agent",
    model: guuey.model,
    // `instruction` already carries your system prompt PLUS the conversation
    // preamble (history, thread memory, working state) — your agent is
    // conversational without writing any state code.
    instruction: guuey.instruction,
    // Your own tools compose with the MCP servers from guuey.json. Drop
    // `...guuey.mcpToolsets` if you want a fully self-contained agent.
    tools: [rollDice, ...guuey.mcpToolsets],
  });
