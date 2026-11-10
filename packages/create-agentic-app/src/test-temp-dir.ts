import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * A fresh directory under the OS temp dir, removed when the calling test
 * finishes, pass or fail. Call it inside a test. Test support only: neither
 * tsup entry (src/index.ts, src/cli.ts) imports it, so it never ships.
 */
export async function testTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
