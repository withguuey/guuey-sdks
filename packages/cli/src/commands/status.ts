import { requireAuth } from '../auth';
import { resolveConfig } from '../config';
import * as out from '../output';

/**
 * Handle the `guuey status` command.
 *
 * Shows connectivity, app info, and agent runtime status (if deployed).
 * Requires PAT or Cognito auth — API keys cannot access this endpoint.
 */
export async function status(): Promise<void> {
  const config = resolveConfig();

  if (!config.appId) {
    out.error('Incomplete configuration. Run: guuey config show');
    process.exit(1);
  }

  const auth = requireAuth(); // PAT required — API keys are blocked from management routes

  if (!config.apiUrl) {
    out.error('REST API URL not configured. Ensure amplify_outputs.json is present or set GUUEY_API_URL.');
    process.exit(1);
  }

  console.log(`App ID:   ${config.appId}`);
  console.log(`API:      ${config.apiUrl}`);
  console.log('');

  const baseUrl = config.apiUrl.replace(/\/$/, '');

  try {
    const res = await fetch(`${baseUrl}/apps/${config.appId}`, {
      headers: { Authorization: `Bearer ${auth.pat}` },
    });

    if (res.ok) {
      const data = (await res.json()) as {
        app: {
          name?: string;
          deploymentStatus?: string;
          currentBuildNumber?: number;
        };
      };
      out.success(`Connected — app "${data.app.name ?? config.appId}"`);

      // If deployed, fetch agent runtime status
      const deployStatus = data.app.deploymentStatus;
      if (deployStatus && deployStatus !== 'not_deployed') {
        console.log(`  Deploy:  ${deployStatus}`);
        if (data.app.currentBuildNumber) {
          console.log(`  Build:   #${data.app.currentBuildNumber}`);
        }
        console.log('');
        await showAgentStatus(baseUrl, config.appId, auth.pat);
      }
    } else if (res.status === 401 || res.status === 403) {
      out.error('Authentication failed — check your credentials');
      process.exit(1);
    } else {
      out.error(`Server returned HTTP ${res.status}`);
      process.exit(1);
    }
  } catch (e) {
    out.error(`Cannot reach API: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function showAgentStatus(
  baseUrl: string,
  appId: string,
  token: string,
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/apps/${appId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.log('  Agent status: unavailable');
      return;
    }

    const status = (await res.json()) as {
      runtimeStatus: string;
      replicas: { ready: number; desired: number };
      uptime: string | null;
      lastRestart: string | null;
      pods: Array<{
        name: string;
        phase: string;
        ready: boolean;
        restarts: number;
        age: string;
        resources: {
          request?: { cpu?: string; memory?: string };
          limit?: { cpu?: string; memory?: string };
        };
      }>;
    };

    const statusColor =
      status.runtimeStatus === 'running'
        ? '\x1b[32m'
        : status.runtimeStatus === 'stopped'
          ? '\x1b[90m'
          : '\x1b[33m';
    const reset = '\x1b[0m';

    console.log(`  Runtime: ${statusColor}${status.runtimeStatus}${reset}`);
    console.log(
      `  Pods:    ${status.replicas.ready}/${status.replicas.desired} ready`,
    );
    if (status.uptime) console.log(`  Uptime:  ${status.uptime}`);
    if (status.lastRestart) {
      console.log(
        `  Last restart: ${new Date(status.lastRestart).toLocaleString()}`,
      );
    }

    if (status.pods.length > 0) {
      console.log('');
      for (const pod of status.pods) {
        const readyIcon = pod.ready ? '\x1b[32m●\x1b[0m' : '\x1b[33m○\x1b[0m';
        const cpu = pod.resources.request?.cpu ?? '-';
        const mem = pod.resources.request?.memory ?? '-';
        console.log(
          `  ${readyIcon} ${pod.name.slice(-16).padEnd(16)}  ${pod.phase.padEnd(10)}  restarts: ${pod.restarts}  cpu: ${cpu}  mem: ${mem}  age: ${pod.age}`,
        );
      }
    }
  } catch {
    console.log('  Agent status: unavailable (controller timeout)');
  }
}
