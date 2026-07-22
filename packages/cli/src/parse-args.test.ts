import { describe, expect, it } from 'vitest';
import { parseArgs } from './parse-args.js';

describe('parseArgs', () => {
  it('extracts positional commands and --flag=value pairs', () => {
    expect(parseArgs(['mcp', 'deploy', '--name', 'weather', '--size', 'md'])).toEqual({
      command: ['mcp', 'deploy'],
      flags: { name: 'weather', size: 'md' },
    });
  });

  it('a --flag with no following value (or followed by another flag) is boolean true', () => {
    expect(parseArgs(['deploy', '--force', '--json'])).toEqual({
      command: ['deploy'],
      flags: { force: true, json: true },
    });
  });

  it('a single-dash short flag (-o <file>) parses under its single-character key', () => {
    expect(
      parseArgs(['mcp', 'state', 'export', '--server', 'srv-1', '--user', 'u-1', '-o', 'out.json']),
    ).toEqual({
      command: ['mcp', 'state', 'export'],
      flags: { server: 'srv-1', user: 'u-1', o: 'out.json' },
    });
  });

  it('a short flag followed by another flag (no value) is boolean true', () => {
    expect(parseArgs(['export', '-o', '--json'])).toEqual({
      command: ['export'],
      flags: { o: true, json: true },
    });
  });

  it('a trailing short flag with nothing after it is boolean true', () => {
    expect(parseArgs(['export', '-o'])).toEqual({
      command: ['export'],
      flags: { o: true },
    });
  });
});
