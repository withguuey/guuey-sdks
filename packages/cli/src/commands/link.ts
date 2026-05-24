/**
 * guuey link -- Connect an existing agent to the guuey platform.
 *
 * Usage:
 *   guuey link                            # Interactive prompts
 *   guuey link --url http://localhost:3000 # With endpoint URL
 *   guuey link --url http://localhost:3000 --name "My Agent"
 */

import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isLoggedIn, requireAuth } from '../auth';
import { resolveConfig, loadConfig, saveConfig, saveProjectConfig } from '../config';
import { login } from './login';
import * as out from '../output';

/** Prompt the user for a single line of input. */
function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

/**
 * Handle the `guuey link` command.
 *
 * Connects an existing agent to the guuey platform by:
 * 1. Collecting the agent's endpoint URL
 * 2. Running a health check against the endpoint
 * 3. Discovering available tools
 * 4. Creating a platform app with the endpoint registered
 *
 * @param flags - CLI flags (e.g., `{ url: 'http://...', name: 'My Agent' }`)
 */
export async function link(flags?: Record<string, string | true>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    // 1. Get endpoint URL
    let endpointUrl = flags?.url as string | undefined;
    if (!endpointUrl) {
      endpointUrl = await prompt(rl, 'Agent endpoint URL: ');
    }
    if (!endpointUrl) {
      out.error('Endpoint URL is required.');
      process.exit(1);
    }

    // Normalize: strip trailing slash
    endpointUrl = endpointUrl.replace(/\/$/, '');

    // 2. Health check
    console.log('\nTesting endpoint...');
    try {
      const healthRes = await fetch(`${endpointUrl}/ggui/health`);
      if (healthRes.ok) {
        console.log(`  /ggui/health -> ${healthRes.status} OK`);
      } else {
        console.log(`  /ggui/health -> ${healthRes.status} (warning: not healthy)`);
      }
    } catch (e) {
      console.log(
        `  /ggui/health -> unreachable (${e instanceof Error ? e.message : 'network error'})`,
      );
      console.log('  (continuing anyway -- endpoint may not be running yet)\n');
    }

    // 3. Discover tools
    try {
      const toolsRes = await fetch(`${endpointUrl}/guuey/tools`);
      if (toolsRes.ok) {
        const data = (await toolsRes.json()) as { tools?: Array<{ name: string }> };
        const tools = data.tools ?? [];
        console.log(
          `  /guuey/tools -> ${tools.length} tools found${tools.length > 0 ? ': ' + tools.map((t) => t.name).join(', ') : ''}`,
        );
      }
    } catch {
      console.log('  /guuey/tools -> could not discover tools');
    }

    // 4. Get app name
    let appName = flags?.name as string | undefined;
    if (!appName) {
      appName = (await prompt(rl, '\nApp name: ')) || 'My Agent';
    }

    // 5. Ensure user is authenticated
    if (!isLoggedIn()) {
      console.log('\nNot logged in -- opening browser to authenticate...\n');
      await login();
    }
    const auth = requireAuth();
    const config = resolveConfig();
    const baseUrl = config.host.replace(/\/$/, ''); // Always set — DEFAULT_ENDPOINT fallback

    // 6. Create platform app with endpoint URL
    console.log('\nCreating platform app...');
    const res = await fetch(`${baseUrl}/api/cli/apps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.pat}`,
      },
      body: JSON.stringify({
        name: appName,
        endpointUrl,
        connectionMode: 'endpoint',
        userAuthMode: 'anonymous',
      }),
    });

    if (!res.ok) {
      let message: string;
      try {
        const data = (await res.json()) as { error?: string };
        message = data.error ?? `HTTP ${res.status}`;
      } catch {
        message = `HTTP ${res.status} ${res.statusText}`;
      }
      out.error(`Failed to create app: ${message}`);
      process.exit(1);
    }

    const data = (await res.json()) as { appId: string; apiKey: string };

    out.success(`Created app "${appName}"`);
    console.log('');
    console.log(`  App ID:   ${data.appId}`);
    console.log(`  API Key:  ${data.apiKey}`);
    console.log('');
    console.log('  Save the API key now -- it won\'t be shown again.');
    console.log('');
    console.log(`  Your agent is live at: https://app.guuey.com/${data.appId}`);

    // Write guuey.json with the canonical hosted-overlay shape.
    // §8.4: URL overrides do NOT live in the overlay — `baseUrl` is
    // relocated to `.env` below as `GGUI_HOST`. `project.workspaceId`
    // is populated by a subsequent `guuey pull`.
    saveProjectConfig({
      schema: '1',
      project: { id: data.appId },
      deployments: [],
    });
    console.log('');
    console.log('  Project config saved to guuey.json');

    // Write .env with API key + host override.
    const envPath = join(process.cwd(), '.env');
    await writeFile(
      envPath,
      `GGUI_API_KEY=${data.apiKey}\nGGUI_HOST=${baseUrl}\n`,
    );
    console.log('  API key + host saved to .env');

    // Auto-configure the global CLI config
    const existing = loadConfig();
    existing.appId = data.appId;
    existing.apiKey = data.apiKey;
    saveConfig(existing);

    console.log('');
    console.log('  Auto-configured: app-id and api-key saved to ~/.guuey/config.json');
  } finally {
    rl.close();
  }
}
