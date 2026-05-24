/**
 * @module @guuey/cli
 *
 * Programmatic API for the Guuey CLI. Re-exports the admin API client,
 * configuration loaders, and project config utilities for use in scripts
 * and integrations.
 *
 * For the CLI binary itself, see `cli.ts`.
 *
 * @packageDocumentation
 */

export { createClient, ApiError } from './client';
export type { AdminClient } from './client';
export {
  loadConfig, saveConfig, resolveConfig, resolveFullConfig,
  loadProjectConfig, saveProjectConfig, findProjectConfig,
} from './config';
export type { CliConfig, ProjectConfig, ResolvedConfig } from './config';
