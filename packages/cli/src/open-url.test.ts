/**
 * openUrl (guuey#500) — the non-shell browser opener + protocol allowlist.
 *
 * The two guards under test: a server-supplied value never reaches a shell
 * (win32 goes through rundll32, not `cmd /c start`), and a non-http(s) value
 * is refused before any opener is spawned. child_process is mocked so no real
 * browser is launched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

import { openUrl } from './open-url';

const ORIGINAL_PLATFORM = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
  vi.clearAllMocks();
});

describe('openUrl', () => {
  it('win32: opens via rundll32 with the whole URL as one bound argv element — an &-joined OAuth URL is not severed and cmd is never used', () => {
    setPlatform('win32');
    const url =
      'https://oauth.example.com/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&scope=openid+profile&state=xyz';

    expect(openUrl(url)).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('rundll32.exe');
    expect(command).not.toBe('cmd');
    expect(args[0]).toBe('url.dll,FileProtocolHandler');
    // The full URL is ONE argv slot — the `&` between query params survives
    // intact (the cmd /c start bug severed it here).
    expect(args[1]).toBe(url);
    expect(args[1]).toContain('&redirect_uri=');
    expect(args[1]).toContain('&state=xyz');
  });

  it('darwin: opens via `open` with the URL bound as one argument', () => {
    setPlatform('darwin');
    const url = 'https://x.example/authorize?a=1&b=2';
    expect(openUrl(url)).toBe(true);
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command).toBe('open');
    expect(args).toEqual([url]);
  });

  it('linux: spawns xdg-open only when it exists, and reports false when it does not', () => {
    setPlatform('linux');
    const url = 'https://x.example/authorize?a=1&b=2';

    // xdg-open present: `which` returns without throwing.
    expect(openUrl(url)).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith('xdg-open', [url], expect.any(Function));

    // xdg-open absent: `which` throws → nothing opened, no uncaught error.
    execFileMock.mockClear();
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('which: no xdg-open');
    });
    expect(openUrl(url)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) URL — throws and opens nothing (the injection guard)', () => {
    setPlatform('win32');
    const rejected = [
      'javascript:alert(document.domain)',
      'file:///C:/Windows/System32/calc.exe',
      'ftp://host/path',
      'data:text/html,<script>1</script>',
    ];
    for (const bad of rejected) {
      execFileMock.mockClear();
      expect(() => openUrl(bad)).toThrow(/non-http\(s\)/);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });

  it('refuses a value that is not a URL at all — throws and opens nothing', () => {
    setPlatform('win32');
    // A shell-metacharacter payload is not a parseable absolute URL, so it is
    // rejected before any opener runs.
    for (const bad of ['not a url', '" & calc.exe', 'x`whoami`']) {
      execFileMock.mockClear();
      expect(() => openUrl(bad)).toThrow(/malformed URL/);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  });
});
