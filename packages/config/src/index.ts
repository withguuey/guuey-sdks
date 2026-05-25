/**
 * `@guuey/config` — schemas + loaders for `guuey.json` (the merged
 * platform config file).
 *
 * Post-2026-05-25 slice 7.2: `agent.json` was merged into
 * `guuey.json#agent`. See `docs/plans/2026-05-25-platform-architecture.md`
 * §3.1 + §14.2 for the canonical shape + field-by-field migration.
 *
 * Consumers: `@guuey/cli`, guuey backend (cliApi handlers,
 * nocode-runtime, deploy-controller), framework adapters under
 * `oss/packages/frameworks/*`.
 */
export * from './schema.js';
export * from './agent.js';
export * from './app.js';
export * from './ggui.js';
export * from './loader.js';
export * from './hosting.js';
export * from './system-prompt.js';
