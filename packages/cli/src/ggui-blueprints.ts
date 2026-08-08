/**
 * Client-side blueprint compilation — the `blueprints` leg of the ratified
 * #387 asset contract (guuey#121).
 *
 * ggui has NO server-side compiler: its assets endpoint accepts only
 * already-compiled `{artifactId, version, manifest, compiledBytes}` records
 * and hard-400s on raw sources. So the TSX → ESM step happens HERE, on the
 * developer's machine, mirroring ggui's own push pipeline
 * (`@ggui-ai/cli/push`'s `push-command.ts`).
 *
 * **Why mirror instead of depend.** `@ggui-ai/cli` would be the natural
 * import, but its dependency tree pulls the full generation stack
 * (`@huggingface/transformers` et al.) into a CLI whose install time is a
 * DX surface. We take only the light pieces — `@ggui-ai/artifact-manifest`
 * (the format codec) and `@ggui-ai/protocol` (the record validator) — and
 * mirror the two constants that are pure configuration, each with a sync
 * comment naming its upstream owner. Same pattern as `backend/libs/fs-contract`'s
 * mirrored copies in `@guuey/host`/`deploy-controller`.
 *
 * The project's blueprint source is a seed-pool artifact under
 * `<ggui dir>/blueprints` — `manifest.json` plus a `codes/` directory —
 * whose format `@ggui-ai/artifact-manifest` owns end to end.
 *
 * **Failure posture** mirrors ggui's own pool loader: manifest-level
 * problems (bad JSON, wrong `schemaVersion`) THROW — the artifact is
 * unreadable and a partial push would be a lie. Entry-level problems (a
 * codeRef failing the filename pattern, a record `fromPortableBlueprint`
 * rejects, an unreadable code body) WARN and SKIP that one record — a
 * rejected blueprint is just a cache miss the pod cold-generates through,
 * never a reason to fail the deploy. A TSX that does not COMPILE is the
 * exception and throws: the endpoint is full-state replace, so shipping the
 * set without it would silently DELETE that blueprint server-side, and the
 * developer needs to see the syntax error rather than a quietly shrinking
 * app.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import {
  parsePoolArtifactManifest,
  POOL_ARTIFACT_CODES_DIR,
  POOL_ARTIFACT_CODE_REF_PATTERN,
  POOL_ARTIFACT_MANIFEST_FILENAME,
} from '@ggui-ai/artifact-manifest';
import { fromPortableBlueprint } from '@ggui-ai/protocol/blueprint-key';

/**
 * One CLIENT-SIDE-COMPILED blueprint record on the #387 wire. Mirrors
 * `backend/amplify/functions/shared/ggui-provisioning-client.ts`'s
 * `PushBlueprintRecord` verbatim — duplicated here (not imported) because
 * the CLI is an OSS package (`@guuey/cli`) and cannot depend on the closed
 * backend (`@guuey-private/*`).
 */
export interface PushBlueprintRecord {
  /** `${contractHash}-${variantKey}` — upsert identity, derived client-side. */
  artifactId: string;
  /** Blueprint format schema version — the literal '1' at v1 (not semver). */
  version: string;
  manifest: { contract?: unknown; [k: string]: unknown };
  /** Compiled ESM JS text, pod-evaluated as-is (NOT base64). */
  compiledBytes: string;
}

/**
 * Modules left UNBUNDLED in a compiled blueprint: the iframe runtime
 * bundles React, ReactDOM, `@ggui-ai/wire` and `@ggui-ai/design` inside
 * itself and exposes them on `globalThis.__ggui__`, so a blueprint that
 * bundled its own copies would run against a second React instance and
 * break hooks.
 *
 * SYNC: mirrors `@ggui-ai/dev-stack`'s
 * `src/local-registry/compile-ui.ts#SANDBOX_EXTERNALS`. Changing this list
 * without the runtime's shared-instance registry changing too produces
 * blueprints that fail at render, not at build.
 */
const SANDBOX_EXTERNALS = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  '@ggui-ai/design',
  '@ggui-ai/design/*',
  '@ggui-ai/wire',
  '@ggui-ai/wire/*',
  '@ggui-ai/react',
  '@ggui-ai/react/*',
];

/**
 * Compile one blueprint's TSX source into the ESM JS text the pod
 * evaluates.
 *
 * SYNC: the esbuild options mirror `@ggui-ai/cli`'s `push-command.ts#compileTsx`
 * frozen matrix. The output must stay byte-comparable with what ggui's own
 * push produces, so treat every field here as part of the contract rather
 * than a local tuning knob.
 *
 * The source is written to a temp `.tsx` file because the extension is what
 * drives esbuild's JSX loader selection — passing the code via `stdin`
 * would need an explicit loader and diverge from the frozen matrix.
 */
export async function compileBlueprintTsx(code: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'guuey-blueprint-'));
  const tmpFile = join(dir, 'blueprint.tsx');
  try {
    writeFileSync(tmpFile, code, 'utf-8');
    const result = await build({
      entryPoints: [tmpFile],
      bundle: true,
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      platform: 'browser',
      minify: false,
      write: false,
      external: SANDBOX_EXTERNALS,
      logLevel: 'silent',
    });
    const output = result.outputFiles[0];
    if (!output) {
      throw new Error('esbuild produced no output file for the blueprint source');
    }
    return output.text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Two-space indent to match the deploy orchestrator's own progress lines. */
function warn(message: string): void {
  console.warn(`  ${message}`);
}

/**
 * Compile every blueprint in a project's seed-pool artifact directory into
 * push records.
 *
 * Returns `[]` when the directory carries no `manifest.json` at all — the
 * overwhelmingly common case (a scaffold ships `blueprints/.gitkeep` and
 * nothing else), and not an error: a project simply has no cached UI to
 * push yet.
 *
 * See the file header for the throw-vs-skip rules.
 */
export async function compileProjectBlueprints(
  blueprintsDir: string,
): Promise<PushBlueprintRecord[]> {
  const manifestPath = join(blueprintsDir, POOL_ARTIFACT_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return [];

  const parsed = parsePoolArtifactManifest(readFileSync(manifestPath, 'utf-8'));
  if (!parsed.ok) {
    throw new Error(`ggui blueprint artifact at ${manifestPath} is unreadable: ${parsed.reason}`);
  }
  // Entry-level codec complaints (a dropped malformed entry) are surfaced,
  // never swallowed — the codec has already excluded them from `blueprints`.
  for (const issue of parsed.issues) {
    warn(`ggui blueprint skipped — ${issue}`);
  }

  const records: PushBlueprintRecord[] = [];
  for (const entry of parsed.manifest.blueprints) {
    // Second gate on the SAME rule the codec applies: `codeRef` is about to
    // become a filesystem path here, and a crafted `../../etc/passwd` must
    // not escape `codes/` even if the codec's guard ever regresses.
    if (!POOL_ARTIFACT_CODE_REF_PATTERN.test(entry.codeRef)) {
      warn(`ggui blueprint skipped — codeRef "${entry.codeRef}" is not a valid code-body filename`);
      continue;
    }

    let componentCode: string;
    try {
      componentCode = readFileSync(
        join(blueprintsDir, POOL_ARTIFACT_CODES_DIR, entry.codeRef),
        'utf-8',
      );
    } catch (err) {
      warn(
        `ggui blueprint skipped — code body ${entry.codeRef} could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const imported = fromPortableBlueprint({ ...entry.record, componentCode });
    if (!imported.ok) {
      warn(`ggui blueprint skipped — ${entry.codeRef}: ${imported.reason}`);
      continue;
    }
    const r = imported.record;

    let compiledBytes: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- blueprint counts are small and esbuild already parallelizes internally; sequential keeps a compile error attributable to one record.
      compiledBytes = await compileBlueprintTsx(r.componentCode);
    } catch (err) {
      throw new Error(
        `ggui blueprint ${entry.codeRef} failed to compile: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    records.push({
      artifactId: `${r.contractHash}-${r.variantKey}`,
      version: '1',
      manifest: {
        contract: r.contract,
        ...(r.variance?.seedPrompt ? { description: r.variance.seedPrompt } : {}),
        ...(r.intent ? { intent: r.intent } : {}),
        generatorProtocolVersion: r.generatorProtocolVersion,
        ...(r.toolIdentityCatalogHash
          ? { toolIdentityCatalogHash: r.toolIdentityCatalogHash }
          : {}),
      },
      compiledBytes,
    });
  }

  return records;
}
