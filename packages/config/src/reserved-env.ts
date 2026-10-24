/**
 * Environment names the platform runtime owns on the agent container: the
 * Node, OpenSSL, dynamic-loader and glibc settings its processes start with,
 * and the runtime's own sandbox switch. `agent.env` never sets them.
 *
 * EXACT, case-sensitive names, no prefix rule: the dynamic loader honours a
 * closed set of `LD_*` names (the ones listed here), so an unrelated name that
 * starts with `LD_` (for example `LD_SDK_KEY`) stays settable.
 * `GLIBC_TUNABLES` is read by glibc itself and has no `LD_` prefix.
 *
 * This is the same list the platform's app env doors and deploy door apply,
 * pinned name-for-name by `reserved-env.test.ts` where the platform source is
 * present. The deploy door also refuses names the platform injects into the
 * pod; those are its own business and are not listed here.
 *
 * Applied in two places, and never as a schema rule, so a stored definition
 * that already carries one of these names keeps loading:
 *  - on write, {@link validateAgentEnvNotReserved} refuses a document before it
 *    is deployed;
 *  - at render, the host leaves these names out of the agent's environment
 *    ({@link withoutReservedEnvNames}) and reports each dropped name.
 */
export const RUNTIME_RESERVED_ENV_NAMES = [
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_PATH',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES',
  'GUUEY_SANDBOX',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',
  'LD_BIND_NOT',
  'LD_DEBUG',
  'LD_DEBUG_OUTPUT',
  'LD_DYNAMIC_WEAK',
  'LD_HWCAP_MASK',
  'LD_ORIGIN_PATH',
  'LD_PREFER_MAP_32BIT_EXEC',
  'LD_PROFILE',
  'LD_PROFILE_OUTPUT',
  'LD_SHOW_AUXV',
  'LD_TRACE_LOADED_OBJECTS',
  'LD_USE_LOAD_BIAS',
  'LD_VERBOSE',
  'LD_WARN',
  'LD_ASSUME_KERNEL',
  'GLIBC_TUNABLES',
] as const;

const RUNTIME_RESERVED_ENV_NAME_SET: ReadonlySet<string> = new Set<string>(RUNTIME_RESERVED_ENV_NAMES);

/** Whether `name` is one of {@link RUNTIME_RESERVED_ENV_NAMES} (exact, case-sensitive). */
export function isRuntimeReservedEnvName(name: string): boolean {
  return RUNTIME_RESERVED_ENV_NAME_SET.has(name);
}

/**
 * The write-path check for `agent.env`: one human-readable violation per
 * reserved name the document sets, naming the name and never its value
 * (empty = clean). Run it on a document about to be deployed, never on a
 * stored one.
 */
export function validateAgentEnvNotReserved(
  agent: { readonly env?: Readonly<Record<string, string>> } | undefined,
): string[] {
  return Object.keys(agent?.env ?? {})
    .filter(isRuntimeReservedEnvName)
    .map(
      (name) =>
        `agent.env.${name}: "${name}" is reserved by the platform runtime and cannot be set — remove it from agent.env`,
    );
}

/**
 * The render-path filter for `agent.env`: the map without any
 * {@link RUNTIME_RESERVED_ENV_NAMES}, plus the names it left out, in the
 * map's own order, so the caller can report each one. The input is not
 * modified.
 */
export function withoutReservedEnvNames(env: Readonly<Record<string, string>> | undefined): {
  env: Record<string, string>;
  dropped: string[];
} {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (isRuntimeReservedEnvName(name)) dropped.push(name);
    else kept[name] = value;
  }
  return { env: kept, dropped };
}
