/**
 * `@guuey/config` — closed schema + types for the Guuey
 * hosted-SaaS agent platform config (`guuey.json`) and the Guuey
 * hosted control-plane shapes (agent sizing, deploy lifecycle,
 * deploy events).
 *
 * Consumers: the closed `guuey` CLI, closed Guuey-side platform
 * code (`@guuey-private/runtime`, `cloud/`). Open packages must
 * not import from here — see `docs/plans/2026-04-17-ggui-oss-split.md`
 * §8 (correction 2026-04-18) for the ownership lock rationale.
 */
export * from './loader.js';
export * from './hosting.js';
export * from './mcp-proxy.js';
export * from './mcp-servers.js';
export * from './system-prompt.js';
export * from './agent-loader.js';
