// guuey#2139 test fixture: the scaffolded google-adk agent's shape
// (templates-src/frameworks/google-adk/src/agent.ts): a factory whose model
// is the platform's STRING model name, plus a nested sub-agent and an
// AgentTool-wrapped agent that name string models too.
import { AgentTool, LlmAgent } from "@google/adk";

export default (guuey) =>
  new LlmAgent({
    name: "my_agent",
    model: guuey.model,
    instruction: () => guuey.instruction,
    tools: [
      ...guuey.mcpToolsets,
      new AgentTool({ agent: new LlmAgent({ name: "tool_agent", model: guuey.model, instruction: () => "help" }) }),
    ],
    subAgents: [new LlmAgent({ name: "sub_agent", model: guuey.model, instruction: () => "help" })],
  });
