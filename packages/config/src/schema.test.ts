import { describe, expect, it } from 'vitest';
import {
  GuueyJsonSchemaError,
  SUPPORTED_GUUEY_JSON_SCHEMA,
  assertSupportedGuueyJsonSchema,
  classifyGuueyJsonSchema,
  guueyJsonUnknownKeys,
  parseGuueyJson,
  safeParseGuueyJson,
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

describe('parseGuueyJson — app.suggestions (starter chips, guuey#533)', () => {
  it('accepts a string array', () => {
    const doc = parseGuueyJson({
      ...base,
      app: { suggestions: ['What does this cost?', 'How do I deploy?'] },
    });
    expect(doc.app?.suggestions).toEqual(['What does this cost?', 'How do I deploy?']);
  });

  it('rejects an over-long chip and too many chips', () => {
    expect(() =>
      parseGuueyJson({ ...base, app: { suggestions: ['x'.repeat(81)] } }),
    ).toThrow();
    expect(() =>
      parseGuueyJson({
        ...base,
        app: { suggestions: Array.from({ length: 25 }, (_, i) => `q${i}`) },
      }),
    ).toThrow();
  });
});

describe('parseGuueyJson — app.builtFor (who the agent is FOR, guuey#1597)', () => {
  it('accepts `personal` and `customers`', () => {
    expect(parseGuueyJson({ ...base, app: { builtFor: 'personal' } }).app?.builtFor).toBe('personal');
    expect(parseGuueyJson({ ...base, app: { builtFor: 'customers' } }).app?.builtFor).toBe('customers');
  });

  it('N−1: a document without the key parses unchanged (absent reads customers on the platform side)', () => {
    expect(parseGuueyJson({ ...base, app: { suggestions: ['hi'] } }).app).not.toHaveProperty('builtFor');
  });

  it('rejects any other value (strict enum — never coerced)', () => {
    expect(() => parseGuueyJson({ ...base, app: { builtFor: 'everyone' } })).toThrow();
  });

  it('lives on the APP section, not the agent section — an agent-level key stays unknown (the pull-safety placement)', () => {
    expect(() => parseGuueyJson({ ...base, agent: { builtFor: 'personal' } })).toThrow();
  });
});

describe('safeParseGuueyJson — the READER mode (guuey#2851: a newer app.* key never breaks an older reader)', () => {
  /** A document from a newer vocabulary: one unknown key in app, app.access, app.page and app.theme. */
  const newer = {
    ...base,
    app: {
      name: 'Helper',
      futureSetting: true,
      access: { guestAccess: true, futureAccessKey: 'x' },
      page: { enabled: false, futurePageKey: 1 },
      theme: { file: 'theme.json', futureThemeKey: 'x' },
    },
  };

  it('strips every unknown key under app, at any depth and through the theme union, and names each one', () => {
    const result = safeParseGuueyJson(newer, { stripUnknownKeys: 'app' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect([...result.warnings].sort()).toEqual([
      'app.access.futureAccessKey',
      'app.futureSetting',
      'app.page.futurePageKey',
      'app.theme.futureThemeKey',
    ]);
    expect(result.data.app).toEqual({
      name: 'Helper',
      access: { guestAccess: true },
      page: { enabled: false },
      theme: { file: 'theme.json' },
    });
  });

  it('needs no structuredClone (React Native\'s Hermes has none): an unknown app key is still stripped and named', () => {
    const original = globalThis.structuredClone;
    Reflect.deleteProperty(globalThis, 'structuredClone');
    try {
      expect(typeof globalThis.structuredClone).toBe('undefined');
      const result = safeParseGuueyJson({ ...base, app: { futureSetting: true } }, { stripUnknownKeys: 'app' });
      expect(result.success && result.warnings).toEqual(['app.futureSetting']);
    } finally {
      globalThis.structuredClone = original;
    }
  });

  it('a BigInt never throws: as an unknown key\'s value it is stripped and named; under a known field it is a failure', () => {
    const unknownValue = safeParseGuueyJson({ ...base, app: { futureLimit: 10n } }, { stripUnknownKeys: 'app' });
    expect(unknownValue.success && unknownValue.warnings).toEqual(['app.futureLimit']);
    const knownField = safeParseGuueyJson(
      { ...base, app: { name: 10n, futureSetting: true } },
      { stripUnknownKeys: 'app' },
    );
    expect(knownField.success).toBe(false);
  });

  it('an undefined-valued optional key next to an unknown app key parses', () => {
    const result = safeParseGuueyJson(
      { ...base, app: { name: undefined, futureSetting: true } },
      { stripUnknownKeys: 'app' },
    );
    expect(result.success && result.warnings).toEqual(['app.futureSetting']);
  });

  it('an own "__proto__" key under app never reaches a prototype: the strict parse names it unknown, the reader strips it from its copy, and the copy keeps it an own key until then', () => {
    // zod never copies an undeclared "__proto__" key into its output (zod v4
    // core schemas.js), and in strict mode it reports it as an unrecognized
    // key. So the reader names it and deletes it from its copy like any other
    // unknown app key. That copy must hold it as an own key, never as a
    // prototype.
    const input: unknown = JSON.parse(
      '{"schema":"1","agent":{},"app":{"name":"A","futureSetting":true,"__proto__":{"x":1}}}',
    );
    const result = safeParseGuueyJson(input, { stripUnknownKeys: 'app' });
    expect(result.success && result.warnings).toEqual(['app.futureSetting', 'app.__proto__']);
    expect(result.success && result.data.app).toEqual({ name: 'A' });
    expect(result.success && Object.getPrototypeOf(result.data.app)).toBe(Object.prototype);
    expect(Reflect.get({}, 'x')).toBeUndefined();
  });

  it('a non-plain app object is never stripped (it is the caller\'s, not a copy): the strict failure comes back and the input keeps its key', () => {
    const app: object = Object.assign(Object.create({}), { unknownKey: 1 });
    const result = safeParseGuueyJson({ ...base, app }, { stripUnknownKeys: 'app' });
    expect(result.success).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(app, 'unknownKey')).toBe(true);
  });

  it('a cycle under an unknown key ends instead of recursing forever', () => {
    const app: { futureSelf?: object } = {};
    app.futureSelf = app;
    const result = safeParseGuueyJson({ ...base, app }, { stripUnknownKeys: 'app' });
    expect(result.success && result.warnings).toEqual(['app.futureSelf']);
    expect(app.futureSelf).toBe(app);
  });

  it('never mutates the input', () => {
    const input = structuredClone(newer);
    safeParseGuueyJson(input, { stripUnknownKeys: 'app' });
    expect(input).toEqual(newer);
  });

  it('the strict parse (no options, the author\'s) still refuses the same document', () => {
    const result = safeParseGuueyJson(newer);
    expect(result.success).toBe(false);
    expect(() => parseGuueyJson(newer)).toThrow();
  });

  it('a document with no unknown key parses with empty warnings in both modes', () => {
    const ok = { ...base, app: { access: { guestAccess: true } } };
    const strict = safeParseGuueyJson(ok);
    const reader = safeParseGuueyJson(ok, { stripUnknownKeys: 'app' });
    expect(strict.success && strict.warnings).toEqual([]);
    expect(reader.success && reader.warnings).toEqual([]);
  });

  it("'app' leaves an unknown key OUTSIDE app refused", () => {
    const result = safeParseGuueyJson(
      { ...base, agent: { futureAgentKey: 1 }, app: { futureSetting: true } },
      { stripUnknownKeys: 'app' },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toEqual(['agent']);
  });

  it("'all' strips an unknown key anywhere in the document", () => {
    const result = safeParseGuueyJson(
      { ...base, agent: { futureAgentKey: 1 }, app: { futureSetting: true } },
      { stripUnknownKeys: 'all' },
    );
    expect(result.success && [...result.warnings].sort()).toEqual(['agent.futureAgentKey', 'app.futureSetting']);
  });

  it('a real error under app still fails, and reports the real error, not the stripped key', () => {
    const result = safeParseGuueyJson(
      { ...base, app: { futureSetting: true, access: { userAuthMode: 'magic' } } },
      { stripUnknownKeys: 'app' },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toEqual(['app.access.userAuthMode']);
  });

  it('an ambiguous union is left alone: a theme that reads as both a file reference and an inline theme is refused', () => {
    const palette = {
      accent: '#000000',
      onAccent: '#ffffff',
      ink: '#111111',
      inkMuted: '#666666',
      surface: '#ffffff',
      canvas: '#fafafa',
      canvasMuted: '#eeeeee',
      error: '#b3261e',
    };
    const inline = { mode: 'light', colors: { light: palette, dark: palette } };
    expect(safeParseGuueyJson({ ...base, app: { theme: inline } }).success).toBe(true);
    const result = safeParseGuueyJson(
      { ...base, app: { theme: { file: 'theme.json', ...inline } } },
      { stripUnknownKeys: 'app' },
    );
    expect(result.success).toBe(false);
  });

  it('a wrong-typed theme file reference is refused, not read as an inline theme with its keys stripped', () => {
    // No member is pure-unknown-keys: the { file } member fails on the type of
    // file, and the inline member fails on its missing required keys.
    const input = { ...base, app: { theme: { file: 123 } } };
    const result = safeParseGuueyJson(input, { stripUnknownKeys: 'app' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.slice(0, 2).join('.'))).toEqual(['app.theme']);
    expect(input.app.theme).toEqual({ file: 123 });
  });
});

describe('guueyJsonUnknownKeys — the keys a strict parse refused as unknown', () => {
  it('names them as dotted paths from a thrown ZodError, union members included', () => {
    let caught: unknown;
    try {
      parseGuueyJson({ ...base, app: { acess: {}, theme: { file: 't.json', extra: 1 } } });
    } catch (err) {
      caught = err;
    }
    expect(guueyJsonUnknownKeys(caught).sort()).toEqual(['app.acess', 'app.theme.extra']);
  });

  it('is empty for any other error', () => {
    let caught: unknown;
    try {
      parseGuueyJson({ ...base, protocol: 'ag-ui' });
    } catch (err) {
      caught = err;
    }
    expect(guueyJsonUnknownKeys(caught)).toEqual([]);
    expect(guueyJsonUnknownKeys(new Error('x'))).toEqual([]);
  });
});
