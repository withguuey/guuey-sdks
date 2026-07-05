import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldMcp } from './scaffold-mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__', 'templates');

describe('scaffoldMcp', () => {
  it('copies mcp-base, resolving NAME_PLACEHOLDER to the name and the scope tokens to the given scope', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-mcp-'));
    const mcpTarget = join(target, 'billing');
    const { mcpDir } = await scaffoldMcp({
      targetDir: mcpTarget,
      name: 'billing',
      scope: 'myproject',
      templatesDir: fixturesDir,
    });
    expect(mcpDir).toBe(mcpTarget);

    const pkg = JSON.parse(await fs.readFile(join(mcpDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@myproject/billing-mcp');

    const server = await fs.readFile(join(mcpDir, 'src', 'server.ts'), 'utf8');
    expect(server).not.toContain('NAME_PLACEHOLDER');
    expect(server).not.toContain('agentic-app-template');
    expect(server).toContain('billing-mcp');
    expect(server).toContain('@myproject');
  });

  it('defaults scope to name (standalone mode)', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-mcp-standalone-'));
    const mcpTarget = join(target, 'weather');
    const { mcpDir } = await scaffoldMcp({
      targetDir: mcpTarget,
      name: 'weather',
      templatesDir: fixturesDir,
    });
    const pkg = JSON.parse(await fs.readFile(join(mcpDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@weather/weather-mcp');
  });

  it('rejects invalid npm-unsafe names', async () => {
    await expect(
      scaffoldMcp({
        targetDir: join(await fs.mkdtemp(join(tmpdir(), 'caa-mcp-bad-'))),
        name: 'Bad Name!',
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/name/i);
  });

  it('refuses a non-empty target directory', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-mcp-exists-'));
    await fs.writeFile(join(target, 'existing.txt'), 'hi');
    await expect(
      scaffoldMcp({
        targetDir: target,
        name: 'billing',
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/not empty/i);
  });

  it('throws a clear error when the mcp-base template is missing', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-mcp-missing-'));
    const emptyTemplatesDir = await fs.mkdtemp(join(tmpdir(), 'caa-mcp-empty-templates-'));
    await expect(
      scaffoldMcp({
        targetDir: join(target, 'billing'),
        name: 'billing',
        templatesDir: emptyTemplatesDir,
      })
    ).rejects.toThrow(/mcp-base template/i);
  });
});
