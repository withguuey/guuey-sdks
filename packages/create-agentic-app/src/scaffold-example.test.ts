import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';
import { scaffoldExample } from './scaffold-example.js';

/**
 * Builds a fixture tarball shaped exactly like codeload's
 * `withguuey/demos/tar.gz/main`: one root dir (`demos-main/`) holding the
 * example dirs, each carrying a guuey.json.
 */
let work: string;
let tarball: string;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'caa-example-test-'));
  const repo = join(work, 'demos-main');
  for (const example of ['trimly', 'deskly']) {
    mkdirSync(join(repo, example, 'prompts'), { recursive: true });
    writeFileSync(
      join(repo, example, 'guuey.json'),
      JSON.stringify({
        schema: '1',
        example,
        // The public demos manifests carry the fleet's deploy economics
        // post-#426-convergence; extraction must strip them (the rider).
        agent: { framework: 'claude-agent-sdk', deploy: { size: 'md' } },
      }),
    );
    writeFileSync(join(repo, example, 'prompts', 'system.md'), `# ${example}\n`);
    writeFileSync(join(repo, example, '.env.example'), 'ANTHROPIC_API_KEY=\n');
  }
  // Repo furniture that must never be offered as an example.
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'leak-scan.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, 'README.md'), '# demos\n');
  tarball = join(work, 'demos.tar.gz');
  await c({ gzip: true, file: tarball, cwd: work }, ['demos-main']);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const fetchFixture = () => Promise.resolve(createReadStream(tarball));

describe('scaffoldExample', () => {
  it('extracts one example subdir as the project root, verbatim', async () => {
    const target = join(work, 'my-app');
    const { projectDir } = await scaffoldExample({
      targetDir: target,
      example: 'trimly',
      git: false,
      fetchTarball: fetchFixture,
    });
    expect(projectDir).toBe(target);
    const manifest = JSON.parse(readFileSync(join(target, 'guuey.json'), 'utf8'));
    expect(manifest.example).toBe('trimly');
    // guuey#426's extraction-strip rider: `agent.deploy` is a per-deployment
    // fact — a fork must not inherit the demo fleet's paid size. The rest
    // of the agent block passes through verbatim.
    expect(manifest.agent.deploy).toBeUndefined();
    expect(manifest.agent.framework).toBe('claude-agent-sdk');
    expect(existsSync(join(target, 'prompts', 'system.md'))).toBe(true);
    // Nothing from outside the example dir leaks in.
    expect(existsSync(join(target, 'README.md'))).toBe(false);
    expect(existsSync(join(target, 'deskly'))).toBe(false);
    // .env.local seeded from the example's .env.example.
    expect(existsSync(join(target, '.env.local'))).toBe(true);
  });

  it('rejects an unknown example naming the real ones (guuey.json defines example-ness)', async () => {
    await expect(
      scaffoldExample({
        targetDir: join(work, 'x'),
        example: 'scripts',
        git: false,
        fetchTarball: fetchFixture,
      }),
    ).rejects.toThrow(/Available: deskly, trimly/);
  });

  it('refuses a non-empty target without force', async () => {
    const target = join(work, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');
    await expect(
      scaffoldExample({ targetDir: target, example: 'trimly', git: false, fetchTarball: fetchFixture }),
    ).rejects.toThrow();
  });
});
