/**
 * React entry point (`@guuey/agent-client/react`).
 *
 * The `useAgentInvoke` hook is the only React-coupled surface — the root
 * subpath (`@guuey/agent-client`) stays React-free (pure SSE helpers, the
 * history reader, and the web adapters). Consumers that only need those never
 * import React at all; consumers that render chat import the hook from here.
 */
export { useAgentInvoke, applyHistoryResult, type HistoryApplication } from "./useAgentInvoke";
