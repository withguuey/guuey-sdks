/**
 * Bring-your-own-key (BYOK) provider keys: each stored provider id, and the
 * environment variable the platform puts that key into on the agent's pod.
 *
 * This is the one place the list is written. The platform's key store, its
 * deploy step and its env doors all import it, so a provider the store accepts
 * is always one the runtime reads, and a plain variable can never take a
 * provider key's name.
 *
 * The ids are the STORED ids (`google`, not the Gemini wire name). A stored
 * key for any other provider (for example an old `bedrock` row) is not in
 * this map: no runtime slot reads it, so it never takes effect.
 */
export const BYOK_PROVIDER_SLOT_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const;

/** A provider id a BYOK key can be set for: a key of {@link BYOK_PROVIDER_SLOT_ENV}. */
export type ByokProviderId = keyof typeof BYOK_PROVIDER_SLOT_ENV;

/** Whether `id` is one of the {@link BYOK_PROVIDER_SLOT_ENV} provider ids (exact, case-sensitive). */
export function isByokProviderId(id: string): id is ByokProviderId {
  return Object.hasOwn(BYOK_PROVIDER_SLOT_ENV, id);
}

/** The {@link BYOK_PROVIDER_SLOT_ENV} provider ids, in the map's order. */
export const BYOK_PROVIDER_IDS: readonly ByokProviderId[] = Object.keys(BYOK_PROVIDER_SLOT_ENV).filter(isByokProviderId);

/** The env variable names a BYOK key is delivered in: the {@link BYOK_PROVIDER_SLOT_ENV} values, in the map's order. */
export const BYOK_SLOT_ENV_NAMES: ReadonlySet<string> = new Set<string>(Object.values(BYOK_PROVIDER_SLOT_ENV));
