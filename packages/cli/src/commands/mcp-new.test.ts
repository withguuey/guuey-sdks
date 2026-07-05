import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldMcp, type ScaffoldMcpOptions } from '@guuey/create-agentic-app';
import {
  mcpNewCore,
  nextFreeDevPort,
  collectUsedDevPorts,
  readProjectScope,
  ensureMcpsWorkspaceGlob,
  MIN_MCP_DEV_PORT,
} from './mcp-new.js';
import { parseGuueyJson, type GuueyJsonV1, type GuueyJsonV1Input } from '@guuey/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesTemplatesDir = join(__dirname, '__fixtures__', 'mcp-base-templates');

/** Bind the real `scaffoldMcp` to the fixture `mcp-base` templatesDir — avoids depending on
 * `@guuey/create-agentic-app`'s `dist/templates` build output existing/being current. */
function fixtureScaffoldMcp(opts: ScaffoldMcpOptions): ReturnType<typeof scaffoldMcp> {
  return scaffoldMcp({ ...opts, templatesDir: fixturesTemplatesDir });
}

async function mkProjectDir(pkgName: string | undefined): Promise<{ root: string; guueyJsonPath: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'cli-mcp-new-'));
  const doc: GuueyJsonV1Input = {
    schema: '1',
    agent: {
      framework: 'claude-agent-sdk',
      model: 'claude-sonnet-5',
      systemPrompt: 'You are a helpful agent.',
    },
  };
  writeFileSync(join(root, 'guuey.json'), JSON.stringify(doc, null, 2) + '\n', 'utf-8');
  if (pkgName) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: pkgName, version: '0.0.0' }, null, 2) + '\n',
      'utf-8',
    );
  }
  return { root, guueyJsonPath: join(root, 'guuey.json') };
}

describe('nextFreeDevPort', () => {
  it('returns MIN_MCP_DEV_PORT when nothing is used', () => {
    expect(nextFreeDevPort([])).toBe(MIN_MCP_DEV_PORT);
  });

  it('skips ports already used, picking the next free one', () => {
    expect(nextFreeDevPort([MIN_MCP_DEV_PORT])).toBe(MIN_MCP_DEV_PORT + 1);
    expect(nextFreeDevPort([MIN_MCP_DEV_PORT, MIN_MCP_DEV_PORT + 1])).toBe(MIN_MCP_DEV_PORT + 2);
  });

  it('ignores ports below MIN_MCP_DEV_PORT and gaps above it', () => {
    expect(nextFreeDevPort([1, 2, MIN_MCP_DEV_PORT + 5])).toBe(MIN_MCP_DEV_PORT);
  });
});

/** A minimal-but-complete `GuueyJsonV1`, `mcpServers` overridable per test — runs the authored
 * input through the real `parseGuueyJson` so schema defaults land exactly like production. */
function makeDoc(mcpServers?: GuueyJsonV1Input['agent']['mcpServers']): GuueyJsonV1 {
  const input: GuueyJsonV1Input = {
    schema: '1',
    agent: {
      framework: 'claude-agent-sdk',
      model: 'claude-sonnet-5',
      systemPrompt: 'You are a helpful agent.',
      ...(mcpServers ? { mcpServers } : {}),
    },
  };
  return parseGuueyJson(input);
}

describe('collectUsedDevPorts', () => {
  it('collects devPort from hosted and external entries, skipping colocated/proxied', () => {
    const doc = makeDoc({
      todo: { kind: 'hosted', source: './mcps/todo', devPort: 6782 },
      weather: { kind: 'external', url: 'https://x.example', devPort: 6783 },
      local: { kind: 'colocated', command: 'node' },
      third: { kind: 'proxied', connection: 'conn-1' },
    });
    expect(collectUsedDevPorts(doc)).toEqual([6782, 6783]);
  });

  it('returns an empty array when mcpServers is absent', () => {
    const doc = makeDoc();
    expect(collectUsedDevPorts(doc)).toEqual([]);
  });
});

describe('readProjectScope', () => {
  it('returns the root package.json name verbatim when unscoped', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'myproject' }), 'utf-8');
    expect(readProjectScope(root)).toBe('myproject');
  });

  it('strips the scope segment from a scoped root name', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-scoped-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/myproject' }), 'utf-8');
    expect(readProjectScope(root)).toBe('acme');
  });

  it('returns undefined when there is no package.json', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'scope-none-'));
    expect(readProjectScope(root)).toBeUndefined();
  });
});

describe('ensureMcpsWorkspaceGlob', () => {
  it('creates pnpm-workspace.yaml with the glob when the file is missing', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'glob-missing-'));
    expect(ensureMcpsWorkspaceGlob(root)).toBe(true);
    const written = await fs.readFile(join(root, 'pnpm-workspace.yaml'), 'utf-8');
    expect(written).toContain('mcps/*');
  });

  it('adds the glob to an existing file that lacks it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'glob-add-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "web"\n', 'utf-8');
    expect(ensureMcpsWorkspaceGlob(root)).toBe(true);
    const written = await fs.readFile(join(root, 'pnpm-workspace.yaml'), 'utf-8');
    expect(written).toContain('mcps/*');
    expect(written).toContain('web');
  });

  it('is a no-op when the glob is already present', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'glob-present-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "mcps/*"\n  - "web"\n', 'utf-8');
    expect(ensureMcpsWorkspaceGlob(root)).toBe(false);
  });
});

describe('mcpNewCore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects an npm-unsafe name naming the rule', async () => {
    await expect(
      mcpNewCore(
        { name: 'Bad Name!' },
        { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => null },
      ),
    ).rejects.toThrow(/npm-safe/i);
  });

  it('project mode: scaffolds mcps/<name>, wires guuey.json, adds the workspace glob when missing', async () => {
    const { root, guueyJsonPath } = await mkProjectDir('myproject');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpNewCore(
      { name: 'billing' },
      { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => guueyJsonPath },
    );

    // Scaffolded into mcps/billing, scoped to the project's own name.
    const pkg = JSON.parse(await fs.readFile(join(root, 'mcps', 'billing', 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@myproject/billing-mcp');

    // guuey.json wired.
    const doc = JSON.parse(await fs.readFile(guueyJsonPath, 'utf-8')) as GuueyJsonV1;
    expect(doc.agent.mcpServers?.billing).toEqual({
      kind: 'hosted',
      source: './mcps/billing',
      devPort: MIN_MCP_DEV_PORT,
    });

    // pnpm-workspace.yaml created with the glob (none existed before).
    const workspaceYaml = await fs.readFile(join(root, 'pnpm-workspace.yaml'), 'utf-8');
    expect(workspaceYaml).toContain('mcps/*');

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toMatch(/Next steps/);
  });

  it('project mode: refuses when mcps/<name> already exists', async () => {
    const { root, guueyJsonPath } = await mkProjectDir('myproject');
    mkdirSync(join(root, 'mcps', 'billing'), { recursive: true });

    await expect(
      mcpNewCore(
        { name: 'billing' },
        { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => guueyJsonPath },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it('project mode: a devPort collision picks the next free port', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'cli-mcp-new-collide-'));
    const doc: GuueyJsonV1Input = {
      schema: '1',
      agent: {
        framework: 'claude-agent-sdk',
        model: 'claude-sonnet-5',
        systemPrompt: 'You are a helpful agent.',
        mcpServers: {
          todo: { kind: 'hosted', source: './mcps/todo', devPort: MIN_MCP_DEV_PORT },
        },
      },
    };
    const guueyJsonPath = join(root, 'guuey.json');
    writeFileSync(guueyJsonPath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpNewCore(
      { name: 'billing' },
      { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => guueyJsonPath },
    );

    const written = JSON.parse(await fs.readFile(guueyJsonPath, 'utf-8')) as GuueyJsonV1;
    expect(written.agent.mcpServers?.billing).toMatchObject({ devPort: MIN_MCP_DEV_PORT + 1 });

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toMatch(/already taken/i);
  });

  it('standalone mode: scaffolds ./<name> with scope defaulting to name, touches no guuey.json', async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'cli-mcp-new-standalone-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpNewCore(
      { name: 'weather', cwd },
      { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => null },
    );

    const pkg = JSON.parse(await fs.readFile(join(cwd, 'weather', 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@weather/weather-mcp');
    expect(existsSync(join(cwd, 'guuey.json'))).toBe(false);

    const printed = logSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(printed).toMatch(/guuey mcp deploy/);
  });

  it('standalone mode: refuses an existing target directory', async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), 'cli-mcp-new-standalone-exists-'));
    mkdirSync(join(cwd, 'weather'));

    await expect(
      mcpNewCore(
        { name: 'weather', cwd },
        { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => null },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it('an explicit --scope wins over the project scope', async () => {
    const { root, guueyJsonPath } = await mkProjectDir('myproject');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await mcpNewCore(
      { name: 'billing', scope: 'custom-scope' },
      { scaffoldMcp: fixtureScaffoldMcp, findProjectConfig: () => guueyJsonPath },
    );

    const pkg = JSON.parse(await fs.readFile(join(root, 'mcps', 'billing', 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('@custom-scope/billing-mcp');
  });
});
