import { describe, it, expect } from 'vitest';
import { renameContent, isProbablyText } from './rename.js';

describe('renameContent', () => {
  it('rewrites scope before bare name (order matters)', () => {
    const input = '{"name":"@agentic-app-template/web","dep":"agentic-app-template"}';
    expect(renameContent(input, 'my-app', 'acme')).toBe('{"name":"@acme/web","dep":"my-app"}');
  });
  it('defaults scope to the project name', () => {
    expect(renameContent('@agentic-app-template/x agentic-app-template', 'cool', 'cool')).toBe(
      '@cool/x cool'
    );
  });
});

describe('isProbablyText', () => {
  it('returns true for plain text buffers', () => {
    expect(isProbablyText(Buffer.from('hello world', 'utf8'))).toBe(true);
  });

  it('returns false when a NUL byte appears in the first 8KB', () => {
    const buf = Buffer.concat([Buffer.from('hello'), Buffer.from([0]), Buffer.from('world')]);
    expect(isProbablyText(buf)).toBe(false);
  });
});
