// guuey#2139 test fixture (graceful-legacy lane): a graceful google-adk module
// whose factory constructs its own model client on every turn. `new Gemini`
// with no apiKey reads GOOGLE_GENAI_API_KEY || GOOGLE_API_KEY ||
// GEMINI_API_KEY from the environment when it is constructed, and throws
// when none is set.
import { Gemini, LlmAgent } from "@google/adk";

export default (guuey) =>
  new LlmAgent({
    name: "own_llm_factory_agent",
    model: new Gemini({ model: guuey.model }),
    instruction: () => guuey.instruction,
    tools: [...guuey.mcpToolsets],
  });
