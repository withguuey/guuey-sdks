// guuey#2139 test fixture (graceful-legacy lane): a graceful google-adk module
// that brings its own model client. `new Gemini({ model })` with no apiKey
// reads GOOGLE_GENAI_API_KEY || GOOGLE_API_KEY || GEMINI_API_KEY from the
// environment when it is constructed, here at import time, and throws when
// none is set.
import { Gemini, LlmAgent } from "@google/adk";

const model = new Gemini({ model: "gemini-2.5-flash" });

export default (guuey) =>
  new LlmAgent({
    name: "own_llm_agent",
    model,
    instruction: () => guuey.instruction,
    tools: [...guuey.mcpToolsets],
  });
