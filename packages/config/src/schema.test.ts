import { describe, expect, it } from 'vitest';
import { parseGuueyJson } from './schema.js';

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
