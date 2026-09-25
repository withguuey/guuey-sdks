import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliApiAuthHeaders, findHandBuiltBearers, GUUEY_CLIENT_CLI, GUUEY_CLIENT_HEADER } from './cli-api-headers';

const SRC = dirname(fileURLToPath(import.meta.url));

describe('cliApiAuthHeaders — every cliApi request names the CLI', () => {
  it('carries the bearer and X-Guuey-Client: cli', () => {
    expect(cliApiAuthHeaders('guuey_user_x')).toEqual({ Authorization: 'Bearer guuey_user_x', 'x-guuey-client': 'cli' });
    expect(GUUEY_CLIENT_HEADER).toBe('x-guuey-client');
    expect(GUUEY_CLIENT_CLI).toBe('cli');
  });
});

describe('findHandBuiltBearers — the source guard', () => {
  it('finds a hand-built bearer header in every form (template, concatenation, set, assignment); the builder call and prose are not one', () => {
    expect(findHandBuiltBearers('headers: { Authorization: `Bearer ${pat}` },')).toEqual(['Authorization: `Bearer ${pat}`']);
    expect(findHandBuiltBearers("headers: { 'Authorization': `Bearer ${token}` }")).toEqual(["'Authorization': `Bearer ${token}`"]);
    expect(findHandBuiltBearers('headers: { authorization: `Bearer ${t}` }')).toEqual(['authorization: `Bearer ${t}`']);
    expect(findHandBuiltBearers("headers: { Authorization: 'Bearer ' + pat }")).toEqual(["'Bearer ' +"]);
    expect(findHandBuiltBearers('const h = "Bearer " + token;')).toEqual(['"Bearer " +']);
    expect(findHandBuiltBearers("headers.set('Authorization', value);")).toEqual([".set('Authorization'"]);
    expect(findHandBuiltBearers('init.headers["authorization"] = value;')).toEqual(['["authorization"] =']);
    expect(findHandBuiltBearers('headers.Authorization = value;')).toEqual(['.Authorization =']);
    expect(findHandBuiltBearers('headers: { ...cliApiAuthHeaders(pat) },')).toEqual([]);
    expect(findHandBuiltBearers("if (init.headers.Authorization === undefined || h['Authorization'] == null) return;")).toEqual([]);
    expect(findHandBuiltBearers(' * the raw `Authorization: Bearer` on direct curl calls.')).toEqual([]);
  });

  it('no CLI source builds a bearer header by hand: every cliApi request goes through the builder', () => {
    // Not cliApi, so not this header's business: the builder itself; `guuey dev`'s
    // local MCP servers; and the programmatic admin client (`createClient`, part of
    // the package's public API), which calls the console host's /api/admin.
    const EXEMPT = new Set(['cli-api-headers.ts', 'dev/dev-server.ts', 'client.ts']);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files
      .filter((p) => !EXEMPT.has(relative(SRC, p)))
      .flatMap((p) => findHandBuiltBearers(readFileSync(p, 'utf8')).map((hit) => `${relative(SRC, p)}: ${hit}`));
    expect(offenders).toEqual([]);
  });
});
