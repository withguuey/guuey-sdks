import { describe, expect, it } from 'vitest';
import {
  GuueyJsonSchemaError,
  SUPPORTED_GUUEY_JSON_SCHEMA,
  assertSupportedGuueyJsonSchema,
  classifyGuueyJsonSchema,
  parseGuueyJson,
} from './schema.js';

/**
 * Minimal valid `agent` section — all fields optional; empty object is
 * the smallest shape `AgentSectionV1` accepts.
 */
const minimalAgent = {};

/** Minimal valid base document — used across multiple describe blocks. */
const base = { schema: '1', agent: minimalAgent };

describe('parseGuueyJson — top-level protocol field', () => {
  it('defaults protocol to silver when omitted', () => {
    expect(parseGuueyJson(base).protocol).toBe('silver');
  });

  it('accepts bypass', () => {
    expect(parseGuueyJson({ ...base, protocol: 'bypass' }).protocol).toBe('bypass');
  });

  it('rejects an unknown protocol value (ag-ui)', () => {
    expect(() => parseGuueyJson({ ...base, protocol: 'ag-ui' })).toThrow();
  });
});

describe('parseGuueyJson — top-level worker field', () => {
  it('accepts a worker entry override and leaves it absent by default', () => {
    expect(parseGuueyJson(base).worker).toBeUndefined();
    expect(parseGuueyJson({ ...base, worker: './echo-worker.e2e.mjs' }).worker).toBe(
      './echo-worker.e2e.mjs',
    );
  });

  it('rejects an empty worker path', () => {
    expect(() => parseGuueyJson({ ...base, worker: '' })).toThrow();
  });
});

describe('parseGuueyJson — top-level runtime.router field', () => {
  it('accepts runtime.router = v1', () => {
    const doc = parseGuueyJson({
      schema: '1',
      agent: { systemPrompt: 'x' },
      runtime: { router: 'v1' },
    });
    expect(doc.runtime?.router).toBe('v1');
  });

  it('rejects an unknown router version', () => {
    expect(() =>
      parseGuueyJson({ schema: '1', agent: { systemPrompt: 'x' }, runtime: { router: 'v2' } }),
    ).toThrow();
  });

  it('omitting runtime is valid (defaults to v1 semantically)', () => {
    const doc = parseGuueyJson({ schema: '1', agent: minimalAgent });
    expect(doc.runtime).toBeUndefined();
  });
});

describe('parseGuueyJson — app.access (agents-as-code, guuey#190)', () => {
  it('accepts the four reconcilable fields with the API field names', () => {
    const doc = parseGuueyJson({
      ...base,
      app: {
        access: {
          userAuthMode: 'byo',
          userAuthConfig: { issuerUrl: 'https://id.example.com', audience: 'console' },
          allowedDomains: ['https://console.example.com'],
          guestAccess: false,
        },
      },
    });
    expect(doc.app?.access).toEqual({
      userAuthMode: 'byo',
      userAuthConfig: { issuerUrl: 'https://id.example.com', audience: 'console' },
      allowedDomains: ['https://console.example.com'],
      guestAccess: false,
    });
  });

  it('every field is optional (PUT-per-field: absent = untouched) and null clears the issuer binding', () => {
    const doc = parseGuueyJson({ ...base, app: { access: { userAuthConfig: null } } });
    expect(doc.app?.access).toEqual({ userAuthConfig: null });
  });

  it('rejects an unknown auth mode and unknown keys (tier is NOT declarable here)', () => {
    expect(() =>
      parseGuueyJson({ ...base, app: { access: { userAuthMode: 'magic' } } }),
    ).toThrow();
    expect(() => parseGuueyJson({ ...base, app: { access: { tier: 'pro' } } })).toThrow();
  });
});

describe('parseGuueyJson — app.page (posture-as-code, guuey#286)', () => {
  it('accepts all six patch fields with the API field names', () => {
    const doc = parseGuueyJson({
      ...base,
      app: {
        page: {
          enabled: false,
          welcomeCopy: 'Ask the helper anything.',
          ctaLabel: 'Read the docs',
          ctaUrl: 'https://docs.example.com',
          identityEndpointUrl: 'https://id.example.com/me',
          noindex: true,
        },
      },
    });
    expect(doc.app?.page).toEqual({
      enabled: false,
      welcomeCopy: 'Ask the helper anything.',
      ctaLabel: 'Read the docs',
      ctaUrl: 'https://docs.example.com',
      identityEndpointUrl: 'https://id.example.com/me',
      noindex: true,
    });
  });

  it('every field is optional (PUT-per-field: absent = untouched) and null clears a member', () => {
    const doc = parseGuueyJson({ ...base, app: { page: { welcomeCopy: null, enabled: null } } });
    expect(doc.app?.page).toEqual({ welcomeCopy: null, enabled: null });
  });

  it('shape only — values are the platform validator\'s: wrong types and unknown keys reject (slug is NOT declarable here)', () => {
    expect(() => parseGuueyJson({ ...base, app: { page: { enabled: 'off' } } })).toThrow();
    expect(() => parseGuueyJson({ ...base, app: { page: { indexable: true } } })).toThrow();
    expect(() => parseGuueyJson({ ...base, app: { page: { slug: 'my-agent' } } })).toThrow();
  });
});

describe('schema-version stance (guuey#248 b2) — SUPPORTED_GUUEY_JSON_SCHEMA + the gate', () => {
  it('the zod literal and the exported constant are the same value (one source of truth)', () => {
    expect(SUPPORTED_GUUEY_JSON_SCHEMA).toBe('1');
    expect(parseGuueyJson(base).schema).toBe(SUPPORTED_GUUEY_JSON_SCHEMA);
  });

  it('classifies equal / newer / invalid without throwing (nothing is "older" than the first version)', () => {
    expect(classifyGuueyJsonSchema({ schema: '1' })).toEqual({ kind: 'supported', found: '1' });
    expect(classifyGuueyJsonSchema({ schema: '2' })).toEqual({ kind: 'newer', found: '2' });
    expect(classifyGuueyJsonSchema({ schema: '10' })).toEqual({ kind: 'newer', found: '10' });
    // Not a decimal integer string ⇒ the shape parse owns the message.
    expect(classifyGuueyJsonSchema({ schema: '0' })).toEqual({ kind: 'invalid', found: '0' });
    expect(classifyGuueyJsonSchema({ schema: 1 })).toEqual({ kind: 'invalid', found: undefined });
    expect(classifyGuueyJsonSchema({ schema: 'v1' })).toEqual({ kind: 'invalid', found: 'v1' });
    expect(classifyGuueyJsonSchema({})).toEqual({ kind: 'invalid', found: undefined });
    expect(classifyGuueyJsonSchema(null)).toEqual({ kind: 'invalid', found: undefined });
    expect(classifyGuueyJsonSchema('nope')).toEqual({ kind: 'invalid', found: undefined });
  });

  it('a NEWER schema is refused with SCHEMA_TOO_NEW and the upgrade remedy', () => {
    let caught: unknown;
    try {
      assertSupportedGuueyJsonSchema({ schema: '2', agent: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuueyJsonSchemaError);
    const e = caught as GuueyJsonSchemaError;
    expect(e.code).toBe('SCHEMA_TOO_NEW');
    expect(e.found).toBe('2');
    expect(e.message).toMatch(/schema "2"/);
    expect(e.message).toMatch(/npm i -g @guuey\/cli@latest/);
  });

  it('a supported schema passes the gate silently; an invalid one is left to the shape parse', () => {
    expect(() => assertSupportedGuueyJsonSchema({ schema: '1', agent: {} })).not.toThrow();
    expect(() => assertSupportedGuueyJsonSchema({ schema: 'v1', agent: {} })).not.toThrow();
    expect(() => parseGuueyJson({ schema: 'v1', agent: {} })).toThrow();
  });
});
