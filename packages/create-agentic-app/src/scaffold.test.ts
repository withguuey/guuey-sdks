import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from './scaffold.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '__fixtures__', 'templates');

describe('scaffold', () => {
  it('copies the tree, renames, seeds .env.local, refuses non-empty without force', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-'));
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'demo',
      framework: 'claude-agent-sdk',
      git: false,
      templatesDir: fixturesDir,
    });
    const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo');
    await expect(fs.stat(join(projectDir, '.env.local'))).resolves.toBeTruthy();
    await expect(
      scaffold({
        targetDir: target,
        name: 'demo',
        framework: 'claude-agent-sdk',
        git: false,
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/not empty/i);
  });

  it('rejects invalid npm names', async () => {
    await expect(
      scaffold({
        targetDir: 'x',
        name: 'Bad Name!',
        framework: 'claude-agent-sdk',
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/name/i);
  });

  it('overwrites into a non-empty target when force is set', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-force-'));
    await fs.writeFile(join(target, 'existing.txt'), 'hi');
    const { projectDir } = await scaffold({
      targetDir: target,
      name: 'demo2',
      framework: 'claude-agent-sdk',
      git: false,
      force: true,
      templatesDir: fixturesDir,
    });
    const pkg = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('demo2');
  });

  it('throws a clear error naming available frameworks when the template dir is missing', async () => {
    const target = await fs.mkdtemp(join(tmpdir(), 'caa-missing-'));
    await expect(
      scaffold({
        targetDir: target,
        name: 'demo3',
        // fixturesDir only has a claude-agent-sdk template, so this framework is absent
        framework: 'openai-agents-sdk',
        git: false,
        templatesDir: fixturesDir,
      })
    ).rejects.toThrow(/claude-agent-sdk/);
  });
});
