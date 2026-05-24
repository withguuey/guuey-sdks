/**
 * guuey typegen — Generate TypeScript types from predefined blueprint specs.
 *
 * Scans spec.json files in the predefined blueprints directory and produces
 * a .d.ts file with typed interfaces for each blueprint.s props.
 *
 * Usage:
 *   guuey typegen                         # Output to stdout
 *   guuey typegen --out ggui-blueprints.d.ts  # Write to file
 *   guuey typegen --path ./my-blueprints   # Custom blueprints directory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

interface PropSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'function' | 'object' | 'array';
  required: boolean;
  description: string;
  defaultValue?: unknown;
}

interface BlueprintSpec {
  name: string;
  level: string;
  category: string;
  description: string;
  interface: {
    props: PropSpec[];
    callbacks: string[];
    slots: string[];
  };
}

/** Map PropSpec type strings to TypeScript types */
function propTypeToTs(type: PropSpec['type']): string {
  switch (type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'function': return '(...args: unknown[]) => unknown';
    case 'object': return 'Record<string, unknown>';
    case 'array': return 'unknown[]';
    default: return 'unknown';
  }
}

/** Convert a spec name to a valid TS interface name */
function toInterfaceName(specName: string): string {
  return specName.replace(/[^a-zA-Z0-9]/g, '') + 'Props';
}

/** Convert a directory/spec name to a kebab-case blueprint key */
function toBlueprintKey(dirName: string): string {
  return dirName;
}

/** Recursively find all spec.json files under a directory */
function findSpecFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSpecFiles(fullPath));
    } else if (entry.name === 'spec.json') {
      results.push(fullPath);
    }
  }

  return results;
}

/** Resolve the blueprints directory — try common locations */
function resolveBlueprintsDir(customPath?: string): string {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Blueprints directory not found: ${resolved}`);
    }
    return resolved;
  }

  // Resolve the bundled @ggui-ai/predefined package — its package.json lives at
  // its directory root, so dirname() of the resolved path is the data root.
  try {
    return path.dirname(
      requireFromHere.resolve('@ggui-ai/predefined/package.json'),
    );
  } catch {
    // Fall through to legacy candidates for ad-hoc trees that don't resolve
    // the package (older installs, partial checkouts).
  }

  const candidates = [
    'packages/predefined',
    'node_modules/@ggui-ai/design/dist/blueprints',
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return resolved;
  }

  throw new Error(
    'Could not find blueprints directory. Use --path to specify the location.\n' +
    'Tried @ggui-ai/predefined + ' + candidates.join(', '),
  );
}

/**
 * Handle the `guuey typegen` command.
 * Scans predefined blueprint `spec.json` files and generates a TypeScript
 * declaration file with typed interfaces for each blueprint.s props.
 *
 * @param flags - CLI flags (`--out <file>` for output path, `--path <dir>` for blueprints directory)
 */
export function typegen(flags: Record<string, string | true>): void {
  const outFile = typeof flags.out === 'string' ? flags.out : undefined;
  const customPath = typeof flags.path === 'string' ? flags.path : undefined;

  let blueprintsDir: string;
  try {
    blueprintsDir = resolveBlueprintsDir(customPath);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }

  const specFiles = findSpecFiles(blueprintsDir).sort();

  if (specFiles.length === 0) {
    console.error(`✗ No spec.json files found in ${blueprintsDir}`);
    process.exit(1);
  }

  // Parse all specs
  const blueprints: Array<{ key: string; spec: BlueprintSpec; dirName: string }> = [];

  for (const specFile of specFiles) {
    try {
      const raw = fs.readFileSync(specFile, 'utf-8');
      const spec = JSON.parse(raw) as BlueprintSpec;
      const dirName = path.basename(path.dirname(specFile));
      blueprints.push({ key: toBlueprintKey(dirName), spec, dirName });
    } catch (err) {
      console.error(`⚠ Skipping ${specFile}: ${(err as Error).message}`);
    }
  }

  if (blueprints.length === 0) {
    console.error('✗ No valid spec.json files found');
    process.exit(1);
  }

  // Generate TypeScript
  const lines: string[] = [];
  lines.push('// Auto-generated by: guuey typegen');
  lines.push('// Do not edit manually — regenerate with: guuey typegen --out ggui-blueprints.d.ts');
  lines.push('');
  lines.push("import type { GenerationStrategy } from '@ggui-ai/protocol';");
  lines.push('');

  // Generate per-blueprint prop interfaces
  for (const { spec } of blueprints) {
    const interfaceName = toInterfaceName(spec.name);
    lines.push(`/** ${spec.description} */`);
    lines.push(`export interface ${interfaceName} {`);

    for (const prop of spec.interface.props) {
      const opt = prop.required ? '' : '?';
      const tsType = propTypeToTs(prop.type);
      lines.push(`  /** ${prop.description} */`);
      lines.push(`  ${prop.name}${opt}: ${tsType};`);
    }

    // Add callbacks as optional function props
    for (const cb of spec.interface.callbacks) {
      lines.push(`  /** Callback: ${cb} */`);
      lines.push(`  ${cb}?: (...args: unknown[]) => void;`);
    }

    lines.push('}');
    lines.push('');
  }

  // Generate the unified GguiTemplates map
  lines.push('/** Map of all predefined blueprint names to their props types. */');
  lines.push('export interface GguiTemplates {');
  for (const { key, spec } of blueprints) {
    const interfaceName = toInterfaceName(spec.name);
    lines.push(`  '${key}': ${interfaceName};`);
  }
  lines.push('}');
  lines.push('');

  // Generate convenience type aliases
  lines.push('/** All available predefined blueprint names. */');
  lines.push('export type GguiTemplateName = keyof GguiTemplates;');
  lines.push('');
  lines.push('/** Props type for a given blueprint name. */');
  lines.push('export type GguiTemplateProps<T extends GguiTemplateName> = GguiTemplates[T];');
  lines.push('');

  // Generate options type for useGenerate
  lines.push('/** Options for typed generation. */');
  lines.push('export interface TypedGenerateOptions<T extends GguiTemplateName> {');
  lines.push('  /** Generation strategy (default: "strict" when using a blueprint name) */');
  lines.push('  strategy?: GenerationStrategy;');
  lines.push('  /** Props data to pass to the blueprint */');
  lines.push('  data?: Partial<GguiTemplates[T]>;');
  lines.push('}');
  lines.push('');

  const output = lines.join('\n') + '\n';

  if (outFile) {
    const outPath = path.resolve(outFile);
    fs.writeFileSync(outPath, output, 'utf-8');
    console.log(`✓ Generated ${blueprints.length} blueprint types → ${outPath}`);
  } else {
    process.stdout.write(output);
  }
}
