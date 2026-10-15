import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EnvPlaceholderError,
  envPlaceholderNames,
  parseAuthoredGuueyJson,
  resolveEnvPlaceholders,
} from './env-placeholders.js';
import { loadGuueyJson, readGuueyJsonFile, writeGuueyJsonFile } from './loader.js';
import { parseGuueyJson, safeParseGuueyJson } from './schema.js';

/** One manifest for every environment: the MCP url and the BYO issuer come from the deploying shell. */
function authored(overrides?: { url?: string; issuerUrl?: string; audience?: string; secrets?: string[] }) {
  return {
    schema: '1',
    agent: {
      model: 'claude-sonnet-5',
      systemPrompt: 'inline prompt',
      mcpServers: {
        product: {
          kind: 'external',
          url: overrides?.url ?? '${env.PRODUCT_MCP_URL}',
          headers: { Authorization: 'Bearer ${env.PRODUCT_TOKEN}' },
        },
      },
      secrets: overrides?.secrets ?? ['PRODUCT_TOKEN'],
    },
    app: {
      access: {
        userAuthMode: 'byo',
        userAuthConfig: {
          issuerUrl: overrides?.issuerUrl ?? '${env.PRODUCT_ISSUER_URL}',
          audience: overrides?.audience ?? '${env.PRODUCT_AUDIENCE}',
        },
      },
    },
  };
}

const STAGING = {
  PRODUCT_MCP_URL: 'https://mcp.staging.example.com/mcp',
  PRODUCT_ISSUER_URL: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_staging',
  PRODUCT_AUDIENCE: 'staging-client',
};

describe('parseAuthoredGuueyJson — the placeholder form is accepted where the CLI resolves it', () => {
  it('accepts ${env.NAME} as the whole url and in both userAuthConfig fields', () => {
    const doc = parseAuthoredGuueyJson(authored());
    const product = doc.agent.mcpServers?.product;
    expect(product !== undefined && product !== false && product.kind === 'external' ? product.url : null).toBe(
      '${env.PRODUCT_MCP_URL}',
    );
    expect(doc.app?.access?.userAuthConfig).toEqual({
      issuerUrl: '${env.PRODUCT_ISSUER_URL}',
      audience: '${env.PRODUCT_AUDIENCE}',
    });
  });

  it('accepts ${env.NAME} inside a url (host part) and keeps the authored string', () => {
    const doc = parseAuthoredGuueyJson(authored({ url: 'https://mcp.${env.STAGE}.example.com/mcp' }));
    expect(envPlaceholderNames(doc)).toEqual(['PRODUCT_AUDIENCE', 'PRODUCT_ISSUER_URL', 'STAGE']);
  });

  it('the wire schema itself stays strict: a whole-value placeholder url is not a URL there', () => {
    expect(safeParseGuueyJson(authored()).success).toBe(false);
  });

  it('refuses a malformed placeholder in a resolved field', () => {
    expect(() => parseAuthoredGuueyJson(authored({ url: 'https://${env.}/mcp' }))).toThrow(/malformed/);
    expect(() => parseAuthoredGuueyJson(authored({ audience: '${env.A-B}' }))).toThrow(/malformed/);
  });

  it('refuses ${env.NAME} in the app fields the CLI never resolves', () => {
    const doc = authored();
    const withDomains = { ...doc, app: { access: { ...doc.app.access, allowedDomains: ['${env.HOST}'] } } };
    expect(() => parseAuthoredGuueyJson(withDomains)).toThrow(/app\.access\.allowedDomains\[0\]/);
    const withPage = { ...doc, app: { ...doc.app, page: { ctaLabel: 'Go', ctaUrl: 'https://${env.HOST}/x' } } };
    expect(() => parseAuthoredGuueyJson(withPage)).toThrow(/app\.page\.ctaUrl/);
  });

  it('a manifest without placeholders parses exactly as the wire schema does', () => {
    const plain = authored({ url: 'https://mcp.example.com/mcp', issuerUrl: 'https://id.example.com', audience: 'aud' });
    expect(parseAuthoredGuueyJson(plain)).toEqual(parseGuueyJson(plain));
  });
});

describe('resolveEnvPlaceholders — the CLI substitutes from its environment before anything is sent', () => {
  it('substitutes both the url and the BYO issuer + audience, and names the variables (never values)', () => {
    const { doc, substituted } = resolveEnvPlaceholders(parseAuthoredGuueyJson(authored()), STAGING);
    expect(substituted).toEqual(['PRODUCT_AUDIENCE', 'PRODUCT_ISSUER_URL', 'PRODUCT_MCP_URL']);
    const product = doc.agent.mcpServers?.product;
    expect(product !== undefined && product !== false && product.kind === 'external' ? product.url : null).toBe(
      STAGING.PRODUCT_MCP_URL,
    );
    expect(doc.app?.access?.userAuthConfig).toEqual({
      issuerUrl: STAGING.PRODUCT_ISSUER_URL,
      audience: STAGING.PRODUCT_AUDIENCE,
    });
    // The resolved document passes the strict wire schema and carries no placeholder
    // except the header's secret reference, which the pod resolves.
    expect(() => parseGuueyJson(doc)).not.toThrow();
    const wire = JSON.stringify(doc);
    expect(wire).not.toContain('${env.PRODUCT_MCP_URL}');
    expect(wire).not.toContain('${env.PRODUCT_ISSUER_URL}');
    expect(wire).not.toContain('${env.PRODUCT_AUDIENCE}');
  });

  it('never touches a header secret reference', () => {
    const { doc } = resolveEnvPlaceholders(parseAuthoredGuueyJson(authored()), { ...STAGING, PRODUCT_TOKEN: 'leak' });
    const product = doc.agent.mcpServers?.product;
    expect(product !== undefined && product !== false && product.kind === 'external' ? product.headers : null).toEqual({
      Authorization: 'Bearer ${env.PRODUCT_TOKEN}',
    });
    expect(JSON.stringify(doc)).not.toContain('leak');
  });

  it('fails loudly on an unset or empty variable, naming every one, and sends nothing', () => {
    const doc = parseAuthoredGuueyJson(authored());
    let caught: unknown;
    try {
      resolveEnvPlaceholders(doc, { PRODUCT_MCP_URL: STAGING.PRODUCT_MCP_URL, PRODUCT_AUDIENCE: '' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvPlaceholderError);
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('PRODUCT_ISSUER_URL is not set');
    expect(message).toContain('PRODUCT_AUDIENCE is not set');
    expect(message).not.toContain(STAGING.PRODUCT_MCP_URL);
  });

  it('refuses a variable that is also a declared secret (secrets stay in the pod)', () => {
    const doc = parseAuthoredGuueyJson(authored({ secrets: ['PRODUCT_TOKEN', 'PRODUCT_MCP_URL'] }));
    expect(() => resolveEnvPlaceholders(doc, STAGING)).toThrow(/PRODUCT_MCP_URL is declared in agent\.secrets/);
  });

  it('refuses a value that itself carries a placeholder', () => {
    const doc = parseAuthoredGuueyJson(authored());
    expect(() =>
      resolveEnvPlaceholders(doc, { ...STAGING, PRODUCT_MCP_URL: 'https://${platform.mcpDomain}/mcp' }),
    ).toThrow(/PRODUCT_MCP_URL.*placeholder/);
  });

  it('refuses a substituted url that is not a URL, without printing the value', () => {
    const doc = parseAuthoredGuueyJson(authored());
    let message = '';
    try {
      resolveEnvPlaceholders(doc, { ...STAGING, PRODUCT_MCP_URL: 'not a url' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/agent\.mcpServers\.product\.url/);
    expect(message).not.toContain('not a url');
  });

  it('a document without placeholders comes back as the same object', () => {
    const doc = parseAuthoredGuueyJson(
      authored({ url: 'https://mcp.example.com/mcp', issuerUrl: 'https://id.example.com', audience: 'aud' }),
    );
    const result = resolveEnvPlaceholders(doc, {});
    expect(result.doc).toBe(doc);
    expect(result.substituted).toEqual([]);
  });
});

describe('the guuey.json file helpers read and write the authored form', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-env-placeholders-'));
    path = join(dir, 'guuey.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadGuueyJson accepts the placeholders and a write-back keeps them verbatim', () => {
    writeFileSync(path, JSON.stringify(authored()));
    const loaded = loadGuueyJson(path);
    expect(envPlaceholderNames(loaded.doc)).toEqual(['PRODUCT_AUDIENCE', 'PRODUCT_ISSUER_URL', 'PRODUCT_MCP_URL']);
    writeGuueyJsonFile(path, loaded.doc);
    expect(readFileSync(path, 'utf8')).toContain('"url": "${env.PRODUCT_MCP_URL}"');
    expect(readGuueyJsonFile(path)).toEqual(loaded.doc);
  });
});
