import { describe, expect, it } from 'vitest';

import * as browserEntry from './browser.js';
import * as rootEntry from './index.js';
import {
  BYOK_PROVIDER_IDS,
  BYOK_PROVIDER_SLOT_ENV,
  BYOK_SLOT_ENV_NAME_LIST,
  BYOK_SLOT_ENV_NAMES,
  isByokProviderId,
  type ByokSlotEnvName,
} from './byok-slots.js';

describe('BYOK_PROVIDER_SLOT_ENV', () => {
  it('maps exactly the four stored provider ids to the env slot the runtime reads', () => {
    expect({ ...BYOK_PROVIDER_SLOT_ENV }).toEqual({
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      google: 'GEMINI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
    });
  });

  it('names every slot NAME_API_KEY, the suffix a consumer strips to name its companion values', () => {
    for (const name of Object.values(BYOK_PROVIDER_SLOT_ENV)) expect(name, name).toMatch(/^[A-Z0-9]+_API_KEY$/);
  });
});

describe('the lists derived from the map', () => {
  it('BYOK_PROVIDER_IDS is the map keys, in the map order', () => {
    expect([...BYOK_PROVIDER_IDS]).toEqual(Object.keys(BYOK_PROVIDER_SLOT_ENV));
  });

  it('BYOK_SLOT_ENV_NAMES is the map values, in the map order', () => {
    expect([...BYOK_SLOT_ENV_NAMES]).toEqual(Object.values(BYOK_PROVIDER_SLOT_ENV));
  });

  it('BYOK_SLOT_ENV_NAME_LIST is the map values, in the map order, each typed as a slot name', () => {
    expect([...BYOK_SLOT_ENV_NAME_LIST]).toEqual(Object.values(BYOK_PROVIDER_SLOT_ENV));
    // The type is the literal union of the map's values: a name outside it does not compile.
    const google: ByokSlotEnvName = BYOK_PROVIDER_SLOT_ENV.google;
    expect(BYOK_SLOT_ENV_NAME_LIST).toContain(google);
  });
});

describe('isByokProviderId', () => {
  it('admits each of the four provider ids', () => {
    for (const id of BYOK_PROVIDER_IDS) expect(isByokProviderId(id), id).toBe(true);
  });

  it('refuses a stored provider no runtime slot reads, a slot env name, a different case and inherited keys', () => {
    for (const id of ['bedrock', 'gemini', 'ANTHROPIC_API_KEY', 'Anthropic', '', 'toString', 'constructor', '__proto__']) {
      expect(isByokProviderId(id), id).toBe(false);
    }
  });
});

describe('the package entries', () => {
  it('the root entry and the browser entry export the same map, lists and guard', () => {
    for (const entry of [rootEntry, browserEntry]) {
      expect(entry.BYOK_PROVIDER_SLOT_ENV).toBe(BYOK_PROVIDER_SLOT_ENV);
      expect(entry.BYOK_PROVIDER_IDS).toBe(BYOK_PROVIDER_IDS);
      expect(entry.BYOK_SLOT_ENV_NAMES).toBe(BYOK_SLOT_ENV_NAMES);
      expect(entry.BYOK_SLOT_ENV_NAME_LIST).toBe(BYOK_SLOT_ENV_NAME_LIST);
      expect(entry.isByokProviderId).toBe(isByokProviderId);
    }
  });
});
