import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GuueyJsonV1 } from './schema.js';
import { PLATFORM_URL_FACTS, classifyPlatformUrl, platformUrlFact, resolvePlatformUrl, type PlatformUrlFacts } from './platform-url.js';

const FACTS: PlatformUrlFacts = {
  adminMcpDomain: 'admin-mcp.dev.sandbox.guuey.com',
  platformMcpDomain: 'platform-mcp.dev.sandbox.guuey.com',
  mcpDomain: 'mcp.dev.sandbox.guuey.com',
  apiDomain: 'api.dev.sandbox.guuey.com',
};

describe('classifyPlatformUrl — a URL, a host-only platform template, or the reason it is neither (guuey#1272)', () => {
  it('a plain URL is a url; a non-URL is invalid', () => {
    expect(classifyPlatformUrl('https://mcp.linear.app/mcp')).toEqual({ kind: 'url' });
    expect(classifyPlatformUrl('not a url')).toMatchObject({ kind: 'invalid' });
  });

  it('the placeholder as the ENTIRE host is a template naming its fact', () => {
    expect(classifyPlatformUrl('https://${platform.adminMcpDomain}/mcp')).toEqual({ kind: 'template', fact: 'adminMcpDomain' });
    expect(classifyPlatformUrl('https://${platform.apiDomain}')).toEqual({ kind: 'template', fact: 'apiDomain' });
    expect(classifyPlatformUrl('https://${platform.mcpDomain}/proxy/docs-search/?x=1#f')).toEqual({ kind: 'template', fact: 'mcpDomain' });
  });

  it('anywhere else — a label around it, a port, a path, a query — is refused with a reason a builder can act on', () => {
    for (const bad of [
      'https://x.${platform.apiDomain}/mcp',
      'https://${platform.apiDomain}.example.com/mcp',
      'https://${platform.apiDomain}:8443/mcp',
      'https://example.com/${platform.apiDomain}',
      'https://example.com/?next=${platform.apiDomain}',
      'https://${platform.apiDomain}/${platform.mcpDomain}',
      '${platform.apiDomain}/mcp',
    ]) {
      const shape = classifyPlatformUrl(bad);
      expect(shape.kind, bad).toBe('invalid');
    }
  });

  it('an unknown fact is refused and the reason lists the closed set', () => {
    const shape = classifyPlatformUrl('https://${platform.secretHost}/mcp');
    expect(shape).toMatchObject({ kind: 'invalid' });
    expect(shape.kind === 'invalid' ? shape.reason : '').toContain(PLATFORM_URL_FACTS.join(', '));
  });

  it('platformUrlFact + resolvePlatformUrl: the fact, and the host swapped for the environment\'s', () => {
    expect(platformUrlFact('https://${platform.adminMcpDomain}/mcp')).toBe('adminMcpDomain');
    expect(platformUrlFact('https://admin-mcp.us-east-1.guuey.com/mcp')).toBeNull();
    expect(resolvePlatformUrl('https://${platform.adminMcpDomain}/mcp', FACTS)).toBe('https://admin-mcp.dev.sandbox.guuey.com/mcp');
    expect(resolvePlatformUrl('https://${platform.apiDomain}/v1/x?y=1', FACTS)).toBe('https://api.dev.sandbox.guuey.com/v1/x?y=1');
    expect(resolvePlatformUrl('https://admin-mcp.us-east-1.guuey.com/mcp', FACTS)).toBe('https://admin-mcp.us-east-1.guuey.com/mcp');
  });
});

describe('the manifest schema admits the template on url and mcpResourceUrl, and nothing else moves', () => {
  const manifest = (url: string, mcpResourceUrl?: string) => ({
    schema: '1',
    agent: {
      mode: 'declarative',
      framework: 'claude-agent-sdk',
      model: 'claude-sonnet-5',
      mcpServers: { admin: { kind: 'external', url, credential: 'oauth', ...(mcpResourceUrl !== undefined ? { mcpResourceUrl } : {}) } },
      systemPrompt: 'You are the admin agent.',
    },
  });

  it('accepts a host-only template (and a plain URL, as before)', () => {
    expect(GuueyJsonV1.safeParse(manifest('https://${platform.adminMcpDomain}/mcp')).success).toBe(true);
    expect(GuueyJsonV1.safeParse(manifest('https://${platform.adminMcpDomain}/mcp', 'https://${platform.adminMcpDomain}/')).success).toBe(true);
    expect(GuueyJsonV1.safeParse(manifest('https://admin-mcp.us-east-1.guuey.com/mcp')).success).toBe(true);
  });

  it('refuses a misplaced placeholder or an unknown fact at the field, with the reason', () => {
    const r1 = GuueyJsonV1.safeParse(manifest('https://example.com/?next=${platform.apiDomain}'));
    expect(r1.success).toBe(false);
    expect(r1.success ? '' : r1.error.issues[0]?.path.join('.')).toBe('agent.mcpServers.admin.url');
    const r2 = GuueyJsonV1.safeParse(manifest('https://${platform.nope}/mcp'));
    expect(r2.success ? '' : r2.error.issues[0]?.message).toContain('unknown platform fact');
  });
});

/**
 * The closed set is a hand-copy of the platform's env-domains record (a
 * published package cannot import the private backend). Both sides are read
 * off disk when present; on the withguuey/guuey-sdks mirror there is no
 * backend/, and only the comparison is skipped there (the mirror law).
 */
const ENV_DOMAINS = fileURLToPath(new URL('../../../../backend/amplify/cdk/env-domains.ts', import.meta.url));
describe.skipIf(!existsSync(ENV_DOMAINS))('PLATFORM_URL_FACTS mirrors env-domains.ts field names', () => {
  it('every fact is a field of the EnvDomains interface', () => {
    const src = readFileSync(ENV_DOMAINS, 'utf8');
    const iface = /export interface EnvDomains \{([\s\S]*?)\n\}/.exec(src);
    expect(iface).not.toBeNull();
    const fields = new Set([...iface![1]!.matchAll(/^\s{2}([A-Za-z]+)\??:/gm)].map((m) => m[1]!));
    for (const fact of PLATFORM_URL_FACTS) expect(fields.has(fact), fact).toBe(true);
  });
});
