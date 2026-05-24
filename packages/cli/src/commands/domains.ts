/**
 * guuey domains -- Manage custom domains for deployed agents.
 *
 * Usage:
 *   guuey domains add example.com      # Add custom domain (requires CNAME)
 *   guuey domains list                 # List configured domains
 *   guuey domains remove example.com   # Remove custom domain
 *
 * Before adding a domain, create a CNAME record:
 *   example.com  →  {appId}.agents.guuey.com
 */

import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

async function apiRequest(
  pat: string,
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pat}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function domainsAdd(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains add <domain>');
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  // Validate domain format
  const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  if (!DOMAIN_REGEX.test(domain)) {
    out.error(`Invalid domain: "${domain}". Example: api.example.com`);
    process.exit(1);
  }

  console.log('');
  console.log(`  Adding domain: ${domain}`);

  const res = await apiRequest(auth.pat, baseUrl, 'POST', `/apps/${appId}/domains`, { domain });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { domain: string; verified: boolean; cnameTarget: string };

  console.log('');
  if (data.verified) {
    out.success(`Domain ${domain} added and verified.`);
  } else {
    out.success(`Domain ${domain} added (DNS verification pending).`);
    console.log('');
    console.log(`  Create a CNAME record:`);
    console.log(`    ${domain}  →  ${data.cnameTarget}`);
    console.log('');
    console.log('  DNS propagation may take a few minutes.');
  }
  console.log('');
}

export async function domainsList(
  flags?: Record<string, string | true>,
): Promise<void> {
  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  const res = await apiRequest(auth.pat, baseUrl, 'GET', `/apps/${appId}/domains`);

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    domains: Array<{ domain: string; verified: boolean; addedAt?: string }>;
    defaultDomain: string;
  };

  console.log('');
  console.log(`  Default: ${data.defaultDomain}`);

  if (data.domains.length === 0) {
    console.log('  No custom domains configured.');
  } else {
    console.log('');
    for (const d of data.domains) {
      const status = d.verified ? '✓ verified' : '⏳ pending';
      console.log(`  ${d.domain}  ${status}`);
    }
  }
  console.log('');
}

export async function domainsVerify(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains verify <domain>');
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  console.log('');
  console.log(`  Verifying CNAME for ${domain}...`);

  const res = await apiRequest(auth.pat, baseUrl, 'POST', `/apps/${appId}/domains/verify`, { domain });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as { domain: string; verified: boolean; cnameTarget?: string };

  console.log('');
  if (data.verified) {
    out.success(`Domain ${domain} verified!`);
  } else {
    out.error(`CNAME not found. Create a CNAME record:`);
    console.log(`    ${domain}  →  ${data.cnameTarget}`);
  }
  console.log('');
}

export async function domainsRemove(
  domain: string | undefined,
  flags?: Record<string, string | true>,
): Promise<void> {
  if (!domain) {
    out.error('Usage: guuey domains remove <domain>');
    process.exit(1);
  }

  const auth = requireAuth();
  const config = resolveConfig();
  const appId = (flags?.['app-id'] as string) ?? config.appId;

  if (!appId) {
    out.error('No app ID found. Run "guuey link" or "guuey create" first.');
    process.exit(1);
  }

  if (!config.apiUrl) {
    out.error('REST API URL not configured.');
    process.exit(1);
  }
  const baseUrl = config.apiUrl.replace(/\/$/, '');

  const res = await apiRequest(auth.pat, baseUrl, 'DELETE', `/apps/${appId}/domains`, { domain });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, string>;
    out.error(data.error ?? `Failed: HTTP ${res.status}`);
    process.exit(1);
  }

  console.log('');
  out.success(`Domain ${domain} removed.`);
  console.log('');
}
