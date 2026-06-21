import { describe, expect, it } from 'vitest';
import {
  resolveWorkspaceId,
  resolveServerName,
  validateMcpSize,
  isValidLabel,
  buildUploadBody,
  buildTriggerBody,
  MCP_SIZES,
} from './mcp.js';

describe('resolveWorkspaceId', () => {
  it('flag wins over env', () => {
    expect(
      resolveWorkspaceId({ workspace: 'ws-flag' }, { GUUEY_WORKSPACE: 'ws-env' }),
    ).toBe('ws-flag');
  });

  it('falls back to GUUEY_WORKSPACE env when no flag', () => {
    expect(resolveWorkspaceId({}, { GUUEY_WORKSPACE: 'ws-env' })).toBe('ws-env');
    expect(resolveWorkspaceId(undefined, { GUUEY_WORKSPACE: 'ws-env' })).toBe('ws-env');
  });

  it('returns null when neither is present', () => {
    expect(resolveWorkspaceId({}, {})).toBeNull();
    expect(resolveWorkspaceId(undefined, {})).toBeNull();
  });

  it('ignores a boolean (value-less) --workspace flag and an empty env', () => {
    expect(resolveWorkspaceId({ workspace: true }, {})).toBeNull();
    expect(resolveWorkspaceId({}, { GUUEY_WORKSPACE: '' })).toBeNull();
  });
});

describe('resolveServerName', () => {
  it('flag wins over package.json name', () => {
    expect(resolveServerName({ name: 'from-flag' }, '@guuey/mcp-weather')).toBe('from-flag');
  });

  it('strips the npm scope from a scoped package.json name', () => {
    expect(resolveServerName({}, '@guuey/mcp-weather')).toBe('mcp-weather');
    expect(resolveServerName(undefined, '@scope/sub/deep-name')).toBe('deep-name');
  });

  it('passes an unscoped package.json name through unchanged', () => {
    expect(resolveServerName({}, 'mcp-weather')).toBe('mcp-weather');
  });

  it('returns null when neither flag nor package name is present', () => {
    expect(resolveServerName({}, undefined)).toBeNull();
    expect(resolveServerName(undefined, undefined)).toBeNull();
  });

  it('ignores a boolean (value-less) --name flag, falling back to package name', () => {
    expect(resolveServerName({ name: true }, '@guuey/mcp-weather')).toBe('mcp-weather');
  });
});

describe('validateMcpSize', () => {
  it('accepts every valid size, returning it unchanged', () => {
    for (const size of MCP_SIZES) {
      expect(validateMcpSize(size)).toBe(size);
    }
  });

  it('rejects unknown sizes and non-string inputs (returns null)', () => {
    expect(validateMcpSize('huge')).toBeNull();
    expect(validateMcpSize(true)).toBeNull();
    expect(validateMcpSize(undefined)).toBeNull();
    expect(validateMcpSize('')).toBeNull();
  });
});

describe('isValidLabel', () => {
  it('accepts git-tag-style labels', () => {
    expect(isValidLabel('v1.0')).toBe(true);
    expect(isValidLabel('release-candidate')).toBe(true);
    expect(isValidLabel('build_42')).toBe(true);
  });

  it('rejects spaces, double dots, .lock suffix, and trailing dot', () => {
    expect(isValidLabel('bad label')).toBe(false);
    expect(isValidLabel('..')).toBe(false);
    expect(isValidLabel('x.lock')).toBe(false);
    expect(isValidLabel('v1.')).toBe(false);
  });
});

describe('buildUploadBody', () => {
  it('produces the exact wire shape', () => {
    const body = buildUploadBody({
      workspaceId: 'ws-1',
      name: 'mcp-weather',
      size: 'sm',
      contentLength: 4096,
      sourceHash: 'abc123',
    });
    expect(body).toEqual({
      workspaceId: 'ws-1',
      name: 'mcp-weather',
      size: 'sm',
      contentLength: 4096,
      sourceHash: 'abc123',
    });
    expect(Object.keys(body).sort()).toEqual(
      ['contentLength', 'name', 'size', 'sourceHash', 'workspaceId'].sort(),
    );
  });
});

describe('buildTriggerBody', () => {
  it('uses the passed s3Key as sourceTarballKey and omits versionLabel when no label', () => {
    const body = buildTriggerBody({
      workspaceId: 'ws-1',
      serverId: 'mcp-weather-abc',
      buildNumber: 3,
      size: 'md',
      sourceTarballKey: 'workspaces/ws-1/mcp/mcp-weather-abc/uuid.tar.gz',
      sourceHash: 'deadbeef',
    });
    expect(body.sourceTarballKey).toBe(
      'workspaces/ws-1/mcp/mcp-weather-abc/uuid.tar.gz',
    );
    expect('versionLabel' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      ['buildNumber', 'serverId', 'size', 'sourceHash', 'sourceTarballKey', 'workspaceId'].sort(),
    );
  });

  it('includes versionLabel when a label is given', () => {
    const body = buildTriggerBody({
      workspaceId: 'ws-1',
      serverId: 'mcp-weather-abc',
      buildNumber: 3,
      size: 'md',
      sourceTarballKey: 's3-key',
      sourceHash: 'deadbeef',
      label: 'v1.0',
    });
    expect(body.versionLabel).toBe('v1.0');
  });
});
