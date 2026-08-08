import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import type { DataContract } from '@ggui-ai/protocol';
import { buildGguiAssetPush, pushGguiAssetsLeg, type GguiAssetPushBody } from './ggui-assets.js';
import type { AuthTokens } from './auth.js';
import type { ResolvedConfig } from './config.js';
import type { apiRequest } from './deploy-shared.js';

// ─── buildGguiAssetPush ────────────────────────────────────────────────────

describe('buildGguiAssetPush', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ggui-assets-test-'));
    mkdirSync(join(root, 'ggui', 'blueprints'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write the project's ggui.json with the given document. */
  function writeGguiJson(doc: unknown): void {
    writeFileSync(join(root, 'ggui', 'ggui.json'), JSON.stringify(doc));
  }

  it('lifts generation.model', async () => {
    writeGguiJson({
      schema: '1',
      generation: { model: 'anthropic:claude-haiku-4-5-20251001' },
    });

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body.generation).toEqual({ model: 'anthropic:claude-haiku-4-5-20251001' });
  });

  it('throws on a declared keySource — a PLATFORM fact must not be project input', async () => {
    writeGguiJson({
      schema: '1',
      generation: { model: 'anthropic:claude-haiku-4-5-20251001', keySource: 'own' },
    });
    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
      /generation has unsupported field\(s\) keySource/,
    );
  });

  it('throws on a declared-but-malformed generation.model — never a silent drop (full-state replace would strip the pushed override)', async () => {
    for (const generation of [{}, { model: '' }, { model: 42 }]) {
      writeGguiJson({ schema: '1', generation });
      await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
        /generation\.model must be a non-empty string/,
      );
    }
  });

  it('omits every field the project does not declare', async () => {
    writeGguiJson({ schema: '1', app: { slug: 'demo', name: 'demo' } });

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body).toEqual({});
  });

  it('ignores a project-declared theme (the brand theme is platform-composed)', async () => {
    writeGguiJson({ schema: '1', theme: { preset: 'indigo', mode: 'dark' } });

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body).not.toHaveProperty('theme');
  });

  it('passes gadgets and publicEnv through verbatim when declared', async () => {
    const gadgets = [{ name: 'geolocation', version: '1' }];
    writeGguiJson({ gadgets, publicEnv: { BRAND: 'acme', REGION: 'us-east-1' } });

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body.gadgets).toEqual(gadgets);
    expect(body.publicEnv).toEqual({ BRAND: 'acme', REGION: 'us-east-1' });
  });

  it('throws when the ggui.json config file is missing', async () => {
    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
      /ggui config file not found/,
    );
  });

  it('throws when ggui.json is malformed JSON', async () => {
    writeFileSync(join(root, 'ggui', 'ggui.json'), '{ "generation": ');

    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
      /is not valid JSON/,
    );
  });

  it('throws when ggui.json is valid JSON but not an object', async () => {
    writeGguiJson(['not', 'an', 'object']);

    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
      /must contain a JSON object/,
    );
  });

  it('throws when gadgets is declared with the wrong type', async () => {
    writeGguiJson({ gadgets: { geolocation: true } });

    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(/#gadgets must be/);
  });

  it('throws when publicEnv carries a non-string value', async () => {
    writeGguiJson({ publicEnv: { PORT: 8080 } });

    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(
      /#publicEnv must be/,
    );
  });

  it('throws when the serialized body exceeds the 1 MiB cap', async () => {
    writeGguiJson({ publicEnv: { BIG: 'x'.repeat(1024 * 1024 + 64) } });

    await expect(buildGguiAssetPush(root, './ggui/ggui.json')).rejects.toThrow(/1 MiB/);
  });

  it('includes compiled blueprints when the blueprints dir holds a pool artifact', async () => {
    writeGguiJson({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } });

    const componentCode =
      'export default function Hello({ title }: { title: string }) { return <div>{title}</div>; }\n';
    const contract: DataContract = {
      propsSpec: {
        description: 'greeting card',
        properties: {
          title: { description: 'Title', schema: { type: 'string' }, required: true },
        },
      },
    };
    const full = toPortableBlueprint({
      contract,
      componentCode,
      variance: { seedPrompt: 'a hello card' },
      source: { kind: 'user' },
    });
    const { componentCode: _code, ...record } = full;
    const codeRef = `${createHash('sha256').update(componentCode, 'utf8').digest('hex')}.tsx`;

    const bpDir = join(root, 'ggui', 'blueprints');
    writeFileSync(
      join(bpDir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, blueprints: [{ record, codeRef }] }),
    );
    mkdirSync(join(bpDir, 'codes'), { recursive: true });
    writeFileSync(join(bpDir, 'codes', codeRef), componentCode, 'utf-8');

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body.blueprints).toHaveLength(1);
    expect(body.blueprints?.[0]?.artifactId).toBe(`${full.contractHash}-${full.variantKey}`);
    expect(body.blueprints?.[0]?.compiledBytes).toContain('function Hello');
  });

  it('omits blueprints entirely when the dir holds no pool artifact', async () => {
    writeGguiJson({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } });
    // A fresh scaffold ships `blueprints/.gitkeep` and nothing else.
    writeFileSync(join(root, 'ggui', 'blueprints', '.gitkeep'), '');

    const body = await buildGguiAssetPush(root, './ggui/ggui.json');

    expect(body).not.toHaveProperty('blueprints');
  });
});

// ─── pushGguiAssetsLeg ───────────────────────────────────────────────────

describe('pushGguiAssetsLeg', () => {
  const auth: AuthTokens = { pat: 'pat-test', expiresAt: '2099-01-01T00:00:00.000Z' };
  const config: ResolvedConfig = { host: 'https://guuey.test', apiUrl: 'https://api.guuey.test' };
  const body: GguiAssetPushBody = {
    generation: { model: 'anthropic:claude-haiku-4-5-20251001' },
    blueprints: [
      {
        artifactId: 'abc123-def456',
        version: '1',
        manifest: { contract: {}, generatorProtocolVersion: 'draft-2026-06-12' },
        compiledBytes: 'export default function Hello(){}',
      },
    ],
  };

  it('200 → { pushed: true }, hitting POST /apps/:id/ggui-assets/push with the push body', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api: typeof apiRequest = vi.fn(async (_pat, _cfg, method, path, reqBody) => {
      calls.push({ method, path, body: reqBody });
      return new Response(JSON.stringify({ status: 'pushed' }), { status: 200 });
    });

    const result = await pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api });

    expect(result.pushed).toBe(true);
    expect(calls).toEqual([{ method: 'POST', path: '/apps/app-1/ggui-assets/push', body }]);
  });

  it('surfaces the handler echo of what landed', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'pushed',
          configFields: ['generation'],
          blueprintsPushed: 1,
          blueprintsDeleted: 2,
        }),
        { status: 200 },
      ),
    );

    const result = await pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api });

    expect(result).toEqual({
      pushed: true,
      configFields: ['generation'],
      blueprintsPushed: 1,
      blueprintsDeleted: 2,
    });
  });

  it('200 with an unparseable body is still a success (the push landed)', async () => {
    const api: typeof apiRequest = vi.fn(async () => new Response('not json', { status: 200 }));

    const result = await pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api });

    expect(result).toEqual({ pushed: true });
  });

  it('501 not-yet-supported → { pushed: false, reason }', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 'not-yet-supported', message: 'ggui asset push is not yet enabled on this environment.' }),
        { status: 501 },
      ),
    );

    const result = await pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api });

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('ggui asset push is not yet enabled on this environment.');
  });

  it('501 not-yet-supported with message absent → { pushed: false } with the built-in reason', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'not-yet-supported' }), { status: 501 }),
    );

    const result = await pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api });

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('ggui asset push is not yet enabled on this environment.');
  });

  it('501 not-yet-supported with a non-string message fails the guard → throws (deploy aborts)', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(JSON.stringify({ code: 'not-yet-supported', message: 42 }), { status: 501 }),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api }),
    ).rejects.toThrow();
  });

  it('501 with a code other than not-yet-supported throws (deploy aborts) instead of warn-and-continue', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'other', message: 'some other 501' } }),
        { status: 501 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api }),
    ).rejects.toThrow('some other 501');
  });

  it('other non-2xx (e.g. 500) throws with the real httpError nested {error:{code,message}} shape', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'InternalError', message: 'internal error' } }),
        { status: 500 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api }),
    ).rejects.toThrow('internal error');
  });

  it('400 from ggui-side validation surfaces ggui\'s own message', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'ValidationError',
            message: 'ggui rejected the asset payload: unknown gadget descriptor',
          },
        }),
        { status: 400 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api }),
    ).rejects.toThrow('unknown gadget descriptor');
  });

  it('409 (no federated gguiAppId) throws with the real httpError nested {error:{code,message}} shape', async () => {
    const api: typeof apiRequest = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: 'ConflictError', message: 'App app-1 has no federated ggui app' },
        }),
        { status: 409 },
      ),
    );

    await expect(
      pushGguiAssetsLeg({ appId: 'app-1', body, auth, config }, { api }),
    ).rejects.toThrow('App app-1 has no federated ggui app');
  });
});
