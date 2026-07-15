/**
 * `@guuey/config/browser` — the package minus `loader.js`.
 *
 * `loader.js` imports `node:fs` (guuey.json file resolution), which a
 * browser bundler cannot chunk — importing the root barrel from client
 * code fails `next build` outright (Turbopack: "does not support
 * external modules (request: node:fs)"). Browser consumers (Guuey
 * Studio's agent-config) import this entry instead; Node consumers
 * (CLI, backend, pods) keep the root barrel.
 *
 * Every module re-exported here must stay free of Node builtins.
 */
export * from './schema.js';
export * from './agent.js';
export * from './app.js';
export * from './ggui.js';
export * from './hosting.js';
export * from './system-prompt.js';
export * from './registry.js';
export * from './guuey-context.js';
