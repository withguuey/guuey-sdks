/**
 * `readSecretFromStdin` (guuey#2412): the one way `guuey byok set` takes a
 * provider key. A pipe is read to EOF with exactly one trailing newline
 * stripped; empty and multi-line input is refused. A TTY gets one muted
 * prompt and the key is never echoed.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { readSecretFromStdin } from './secret-input.js';

/** A piped stdin that carries `text` and then ends. */
function pipe(text: string): PassThrough {
  const input = new PassThrough();
  input.end(text);
  return input;
}

/** A terminal stdin: readline runs it in terminal mode, as it does a real TTY. */
function tty(): PassThrough & { isTTY: true } {
  return Object.assign(new PassThrough(), { isTTY: true as const });
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything written to the terminal, both streams. */
function written(): string {
  return [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls].map((call) => String(call[0])).join('');
}

describe('readSecretFromStdin — a pipe', () => {
  it('reads to EOF and strips exactly one trailing \\n', async () => {
    await expect(readSecretFromStdin(pipe('sk-ant-abcd\n'), 'Key: ')).resolves.toEqual({
      ok: true,
      secret: 'sk-ant-abcd',
    });
  });

  it('strips exactly one trailing \\r\\n', async () => {
    await expect(readSecretFromStdin(pipe('sk-ant-abcd\r\n'), 'Key: ')).resolves.toEqual({
      ok: true,
      secret: 'sk-ant-abcd',
    });
  });

  it('takes input with no trailing newline as is', async () => {
    await expect(readSecretFromStdin(pipe('sk-ant-abcd'), 'Key: ')).resolves.toEqual({
      ok: true,
      secret: 'sk-ant-abcd',
    });
  });

  it('refuses empty input and a lone newline', async () => {
    await expect(readSecretFromStdin(pipe(''), 'Key: ')).resolves.toEqual({ ok: false, reason: 'empty' });
    await expect(readSecretFromStdin(pipe('\n'), 'Key: ')).resolves.toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses multi-line input, including a second trailing newline', async () => {
    await expect(readSecretFromStdin(pipe('sk-a\nsk-b\n'), 'Key: ')).resolves.toEqual({
      ok: false,
      reason: 'multi-line',
    });
    await expect(readSecretFromStdin(pipe('sk-a\n\n'), 'Key: ')).resolves.toEqual({
      ok: false,
      reason: 'multi-line',
    });
    await expect(readSecretFromStdin(pipe('sk-a\rsk-b'), 'Key: ')).resolves.toEqual({
      ok: false,
      reason: 'multi-line',
    });
  });

  it('prints no prompt on a pipe', async () => {
    await readSecretFromStdin(pipe('sk-ant-abcd\n'), 'Key: ');
    expect(written()).toBe('');
  });
});

describe('readSecretFromStdin — a TTY', () => {
  it('prompts once, reads one line and never echoes the key', async () => {
    const input = tty();
    const result = readSecretFromStdin(input, 'Paste the anthropic key (input hidden): ');
    input.write('sk-tty-wxyz\r');

    await expect(result).resolves.toEqual({ ok: true, secret: 'sk-tty-wxyz' });
    expect(written()).toContain('Paste the anthropic key (input hidden): ');
    expect(written()).not.toContain('sk-tty-wxyz');
    expect(written().split('Paste the anthropic key').length - 1).toBe(1);
  });

  it('refuses an empty line', async () => {
    const input = tty();
    const result = readSecretFromStdin(input, 'Key: ');
    input.write('\r');

    await expect(result).resolves.toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses an input that ends before a line (Ctrl-D)', async () => {
    const input = tty();
    const result = readSecretFromStdin(input, 'Key: ');
    input.end();

    await expect(result).resolves.toEqual({ ok: false, reason: 'empty' });
  });
});
