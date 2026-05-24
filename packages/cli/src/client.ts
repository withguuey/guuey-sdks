/**
 * Admin API client for the Guuey CLI.
 *
 * Wraps the platform's `/api/admin` endpoints with typed HTTP methods,
 * automatic auth headers, and structured error handling.
 */

import { resolveConfig } from './config';

/**
 * Error thrown when an admin API request fails.
 * Contains the HTTP status code for programmatic error handling.
 */
export class ApiError extends Error {
  constructor(
    /** HTTP status code from the failed request */
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Typed HTTP client for the ggui admin API.
 * All methods prepend `/api/admin` to the path automatically.
 */
export interface AdminClient {
  /** Send a GET request to the admin API. */
  get<T>(path: string): Promise<T>;
  /** Send a PUT request with a JSON body to the admin API. */
  put<T>(path: string, body: unknown): Promise<T>;
  /** Send a POST request with a JSON body to the admin API. */
  post<T>(path: string, body: unknown): Promise<T>;
  /** Send a DELETE request to the admin API. */
  del<T>(path: string): Promise<T>;
}

/**
 * Create an admin API client using the resolved CLI configuration.
 * Reads endpoint, API key, and app ID from the config chain
 * (env vars > project config > global config).
 *
 * @returns Configured admin client
 * @throws Error if endpoint, API key, or app ID is not configured
 */
export function createClient(): AdminClient {
  const config = resolveConfig();

  if (!config.host) {
    throw new Error(
      'No endpoint configured. Run: guuey config set endpoint <url>',
    );
  }
  if (!config.apiKey) {
    throw new Error(
      'No API key configured. Run: guuey config set api-key <key>',
    );
  }
  if (!config.appId) {
    throw new Error('No app ID configured. Run: guuey config set app-id <id>');
  }

  const baseUrl = config.host.replace(/\/$/, '');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'X-Ggui-App-Id': config.appId,
    'Content-Type': 'application/json',
  };

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}/api/admin${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let message: string;
      try {
        const data = await res.json();
        message =
          (data as { error?: string }).error ?? `HTTP ${res.status}`;
      } catch {
        message = `HTTP ${res.status} ${res.statusText}`;
      }
      throw new ApiError(res.status, message);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}
