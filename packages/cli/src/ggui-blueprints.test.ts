import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';
import type { DataContract } from '@ggui-ai/protocol';
import { compileBlueprintTsx, compileProjectBlueprints } from './ggui-blueprints.js';

/**
 * Fixtures are REAL pool artifacts, not hand-shaped JSON: the records are
 * minted with the protocol's own `toPortableBlueprint`, so a shape change
 * upstream surfaces here as a test failure rather than as a fixture that
 * silently stops resembling what ggui actually exports.
 */

const COMPONENT_CODE = `import { Card } from '@ggui-ai/design';

export default function Hello({ title }: { title: string }) {
  return <Card><div className="greeting">{title}</div></Card>;
}
`;

/** A minimal contract that survives `fromPortableBlueprint`'s strict validation. */
const CONTRACT: DataContract = {
  propsSpec: {
    description: 'greeting card',
    properties: {
      title: { description: 'Title', schema: { type: 'string' }, required: true },
    },
  },
};

/** Mint a valid PortableBlueprint, minus `componentCode` (the artifact layout splits it out). */
function mintRecord(seedPrompt = 'a hello card'): { record: object; codeRef: string } {
  const full = toPortableBlueprint({
    contract: CONTRACT,
    componentCode: COMPONENT_CODE,
    variance: { seedPrompt },
    source: { kind: 'user' },
    intent: 'greet the user',
  });
  const { componentCode: _code, ...record } = full;
  const sha = createHash('sha256').update(COMPONENT_CODE, 'utf8').digest('hex');
  return { record, codeRef: `${sha}.tsx` };
}

describe('compileBlueprintTsx', () => {
  it('compiles JSX + TS away and leaves the runtime-shared modules external', async () => {
    const compiled = await compileBlueprintTsx(COMPONENT_CODE);

    // TSX went in, plain ESM JS came out.
    expect(compiled).toContain('function Hello');
    expect(compiled).toContain('jsx(');
    expect(compiled).not.toContain('<div');
    expect(compiled).not.toContain(': string');

    // The iframe runtime supplies these instances — bundling copies of them
    // would give the blueprint a second React.
    expect(compiled).toContain('from "@ggui-ai/design"');
    expect(compiled).toContain('from "react/jsx-runtime"');
  });

  it('throws on source that does not compile', async () => {
    await expect(compileBlueprintTsx('export default function ( {{{ ')).rejects.toThrow();
  });
});

describe('compileProjectBlueprints', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-blueprints-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  /** Lay down a pool artifact: `manifest.json` + `codes/<codeRef>`. */
  function writeArtifact(
    entries: Array<{ record: object; codeRef: string }>,
    opts?: { omitCodeBodies?: boolean },
  ): void {
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        blueprints: entries.map((e) => ({ record: e.record, codeRef: e.codeRef })),
      }),
    );
    if (opts?.omitCodeBodies) return;
    mkdirSync(join(dir, 'codes'), { recursive: true });
    for (const e of entries) {
      writeFileSync(join(dir, 'codes', e.codeRef), COMPONENT_CODE, 'utf-8');
    }
  }

  it('returns [] when the directory carries no manifest.json', async () => {
    expect(await compileProjectBlueprints(dir)).toEqual([]);
  });

  it('returns [] for a directory that does not exist at all', async () => {
    expect(await compileProjectBlueprints(join(dir, 'nope'))).toEqual([]);
  });

  it('compiles one artifact entry into a push record', async () => {
    const entry = mintRecord();
    writeArtifact([entry]);

    const records = await compileProjectBlueprints(dir);

    expect(records).toHaveLength(1);
    const [rec] = records;
    if (!rec) throw new Error('expected one record');

    // artifactId is the upsert identity ggui keys on: contractHash-variantKey.
    const minted = toPortableBlueprint({
      contract: CONTRACT,
      componentCode: COMPONENT_CODE,
      variance: { seedPrompt: 'a hello card' },
      source: { kind: 'user' },
      intent: 'greet the user',
    });
    expect(rec.artifactId).toBe(`${minted.contractHash}-${minted.variantKey}`);
    expect(rec.artifactId).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
    expect(rec.version).toBe('1');

    // compiledBytes is raw ESM JS text — the pod evaluates it as-is.
    expect(rec.compiledBytes).toContain('function Hello');
    expect(rec.compiledBytes).toContain('jsx(');
    expect(rec.compiledBytes).not.toContain('<div');

    expect(rec.manifest.contract).toEqual(CONTRACT);
    expect(rec.manifest.generatorProtocolVersion).toBe(minted.generatorProtocolVersion);
    expect(rec.manifest.description).toBe('a hello card');
    expect(rec.manifest.intent).toBe('greet the user');
    // Absent upstream → absent on the wire, never a null placeholder.
    expect(rec.manifest).not.toHaveProperty('toolIdentityCatalogHash');
  });

  it('skips a record fromPortableBlueprint rejects, keeping the rest of the bulk', async () => {
    const good = mintRecord('the good one');
    // Provenance is required at the trust boundary — stripping `source`
    // is exactly the v1-era record shape importers reject.
    const bad = mintRecord('the bad one');
    const { source: _source, ...recordWithoutSource } = bad.record as { source?: unknown };
    writeArtifact([
      { record: recordWithoutSource, codeRef: 'a'.repeat(64) + '.tsx' },
      good,
    ]);

    const records = await compileProjectBlueprints(dir);

    expect(records).toHaveLength(1);
    expect(records[0]?.manifest.description).toBe('the good one');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ggui blueprint skipped'));
  });

  it('skips a path-traversal codeRef instead of reading outside codes/', async () => {
    const entry = mintRecord();
    writeArtifact([{ record: entry.record, codeRef: '../x.tsx' }]);
    // Belt and braces: make the traversal target real, so a reader that DID
    // escape `codes/` would succeed and this test would catch it.
    writeFileSync(join(dir, 'x.tsx'), COMPONENT_CODE, 'utf-8');

    const records = await compileProjectBlueprints(dir);

    expect(records).toEqual([]);
    // The format codec drops it at parse time (and this module re-checks the
    // same pattern before joining a path); either way it must be reported.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });

  it('skips an entry whose code body is missing rather than failing the bulk', async () => {
    const entry = mintRecord();
    writeArtifact([entry], { omitCodeBodies: true });

    const records = await compileProjectBlueprints(dir);

    expect(records).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/code body .* could not be read/),
    );
  });

  it('throws on a manifest-level problem (unreadable artifact, not a skippable row)', async () => {
    writeFileSync(join(dir, 'manifest.json'), '{ not json');

    await expect(compileProjectBlueprints(dir)).rejects.toThrow(/unreadable/);
  });

  it('throws on a schemaVersion-1 artifact rather than importing it', async () => {
    const entry = mintRecord();
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, blueprints: [entry] }),
    );

    await expect(compileProjectBlueprints(dir)).rejects.toThrow(/unreadable/);
  });

  it('throws with the offending codeRef when a blueprint does not compile', async () => {
    const entry = mintRecord();
    writeArtifact([entry]);
    writeFileSync(join(dir, 'codes', entry.codeRef), 'export default function ( {{{ ', 'utf-8');

    await expect(compileProjectBlueprints(dir)).rejects.toThrow(/failed to compile/);
  });
});
