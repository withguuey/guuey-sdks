/**
 * Behavioural test for the copy-me starter MCP's input limits
 * (`templates-src/mcp-base/src/server.ts`, GHSA-46jr-4wx8-v453).
 *
 * The server is the template's own entry file: it listens on import, so the
 * suite runs it as a child process (Node strips the TypeScript types) on a
 * free port and talks plain JSON-RPC over HTTP to `/mcp`, the way an MCP
 * client does. The two limits are read from the file's exported constants,
 * so re-deriving a number keeps this suite honest without editing it.
 *
 * `echo` always answers with `structuredContent`, so a result without it
 * shows the handler never ran.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'templates-src', 'mcp-base', 'src', 'server.ts');
const serverSource = readFileSync(serverPath, 'utf8');

function declaredNumber(pattern: RegExp, name: string): number {
  const match = pattern.exec(serverSource);
  if (!match) throw new Error(`server.ts does not declare ${name} in the expected form (${pattern})`);
  return Number(match[1]) * Number(match[2] ?? '1');
}

const MAX_TOOL_INPUT_ELEMENTS = declaredNumber(/export const MAX_TOOL_INPUT_ELEMENTS = (\d+);/, 'MAX_TOOL_INPUT_ELEMENTS');
const MAX_REQUEST_BODY_BYTES = declaredNumber(/export const MAX_REQUEST_BODY_BYTES = (\d+)(?: \* (\d+))?;/, 'MAX_REQUEST_BODY_BYTES');

interface TextContent {
  type: string;
  text: string;
}

interface CallToolResult {
  content: TextContent[];
  structuredContent?: { message?: string };
  isError?: boolean;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: CallToolResult;
  error?: { code: number; message: string };
}

let child: ChildProcess;
let baseUrl: string;
let nextId = 1;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('probe server has no TCP address'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function postMcp(body: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body,
  });
}

/** The JSON-RPC message in a response, sent either as JSON or as one SSE `data:` line. */
async function readRpc(res: Response): Promise<RpcResponse> {
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  if (data === undefined) throw new Error(`no data line in the event stream: ${text}`);
  return JSON.parse(data.slice('data: '.length));
}

function echoBody(args: { [key: string]: string }): string {
  return JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'echo', arguments: args } });
}

async function callEcho(args: { [key: string]: string }): Promise<CallToolResult> {
  const res = await postMcp(echoBody(args));
  expect(res.status).toBe(200);
  const rpc = await readRpc(res);
  expect(rpc.error).toBeUndefined();
  if (rpc.result === undefined) throw new Error('tools/call echo returned no result');
  return rpc.result;
}

/** An `echo` arguments object with exactly `members` object members. */
function echoArgs(message: string, members: number): { [key: string]: string } {
  const args: { [key: string]: string } = { message };
  for (let i = 1; i < members; i++) args[`extra${i}`] = 'x';
  return args;
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('NAME_PLACEHOLDER-mcp listening')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`mcp-base server exited (${code}) before listening: ${stderr}`)));
  });
}, 30_000);

afterAll(() => {
  child.kill('SIGKILL');
});

describe('mcp-base template input limits', () => {
  it('declares limits sized to its largest real input', () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(16);
    expect(MAX_REQUEST_BODY_BYTES).toBe(256 * 1024);
  });

  it('answers arguments over MAX_TOOL_INPUT_ELEMENTS with isError and never runs the handler', async () => {
    const result = await callEcho(echoArgs('over the cap', MAX_TOOL_INPUT_ELEMENTS + 1));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      `Invalid arguments for tool echo: arguments contain more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
    );
    expect(result.structuredContent).toBeUndefined();
  });

  it('runs the largest real input, and a payload exactly at the cap', async () => {
    const real = await callEcho({ message: 'hello' });
    expect(real.isError).toBeFalsy();
    expect(real.structuredContent?.message).toBe('hello');

    const atCap = await callEcho(echoArgs('at the cap', MAX_TOOL_INPUT_ELEMENTS));
    expect(atCap.isError).toBeFalsy();
    expect(atCap.structuredContent?.message).toBe('at the cap');
  });

  it('refuses a body over MAX_REQUEST_BODY_BYTES with HTTP 413 and accepts one just under it', async () => {
    const over = await postMcp(echoBody({ message: 'x'.repeat(MAX_REQUEST_BODY_BYTES) }));
    expect(over.status).toBe(413);
    const refusal = await readRpc(over);
    expect(refusal.error?.message).toContain(`Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`);

    const under = await callEcho({ message: 'y'.repeat(MAX_REQUEST_BODY_BYTES - 1024) });
    expect(under.isError).toBeFalsy();
    expect(under.structuredContent?.message).toHaveLength(MAX_REQUEST_BODY_BYTES - 1024);
  });
});
