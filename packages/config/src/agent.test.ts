import { describe, expect, it } from 'vitest';
import {
  AGENT_FRAMEWORKS,
  AGENT_JSON_FILENAME,
  DEFAULT_AGENT_MCP_SERVERS,
  parseAgentJson,
  safeParseAgentJson,
} from './agent.js';

const MINIMAL_V1 = {
  schema: '1' as const,
};

describe('agent.json schema — constants', () => {
  it('filename is exactly "agent.json"', () => {
    expect(AGENT_JSON_FILENAME).toBe('agent.json');
  });

  it('default mcpServers points at mcp.ggui.ai', () => {
    expect(DEFAULT_AGENT_MCP_SERVERS.ggui.url).toBe('https://mcp.ggui.ai');
    expect(DEFAULT_AGENT_MCP_SERVERS.ggui.transport).toBe('http');
  });

  it('framework tuple covers the four supported adapters', () => {
    expect(AGENT_FRAMEWORKS).toEqual([
      'claude-agent-sdk',
      'openai',
      'google-adk',
      'vanilla',
    ]);
  });
});

describe('agent.json schema — minimum viable document', () => {
  it('accepts the bare {schema: "1"} doc', () => {
    const parsed = parseAgentJson(MINIMAL_V1);
    expect(parsed.schema).toBe('1');
    expect(parsed.framework).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.systemPrompt).toBeUndefined();
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('round-trips cleanly through JSON.stringify + re-parse', () => {
    const once = parseAgentJson(MINIMAL_V1);
    const twice = parseAgentJson(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('rejects an unknown top-level field', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      garbage: 'no',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing schema field', () => {
    const result = safeParseAgentJson({});
    expect(result.success).toBe(false);
  });

  it('rejects a non-"1" schema literal', () => {
    const result = safeParseAgentJson({ schema: '2' });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — systemPrompt', () => {
  it('accepts an inline string', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      systemPrompt: 'You are a docs agent.',
    });
    expect(parsed.systemPrompt).toBe('You are a docs agent.');
  });

  it('accepts a {file} reference', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      systemPrompt: { file: 'prompts/system.md' },
    });
    expect(parsed.systemPrompt).toEqual({ file: 'prompts/system.md' });
  });

  it('rejects an empty inline string', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      systemPrompt: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty file path', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      systemPrompt: { file: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field on {file}', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      systemPrompt: { file: 'x.md', extra: 1 },
    });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — framework + model', () => {
  it('accepts each supported framework literal', () => {
    for (const fw of AGENT_FRAMEWORKS) {
      const parsed = parseAgentJson({ ...MINIMAL_V1, framework: fw });
      expect(parsed.framework).toBe(fw);
    }
  });

  it('rejects an unknown framework', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      framework: 'tensorflow',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a free-form model string', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      model: 'claude-sonnet-4-6',
    });
    expect(parsed.model).toBe('claude-sonnet-4-6');
  });

  it('rejects an empty model string', () => {
    const result = safeParseAgentJson({ ...MINIMAL_V1, model: '' });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — mcpServers', () => {
  it('accepts a single http server with url only', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        ggui: { url: 'https://mcp.ggui.ai' },
      },
    });
    expect(parsed.mcpServers?.ggui.url).toBe('https://mcp.ggui.ai');
  });

  it('accepts a stdio entry with command + args', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        local: {
          transport: 'stdio',
          command: '/usr/bin/mcp-server',
          args: ['--port', '8080'],
        },
      },
    });
    expect(parsed.mcpServers?.local.command).toBe('/usr/bin/mcp-server');
    expect(parsed.mcpServers?.local.args).toEqual(['--port', '8080']);
  });

  it('accepts static headers', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        weather: {
          url: 'https://weather.example.com/mcp',
          headers: { Authorization: 'Bearer ${env.WEATHER_KEY}' },
        },
      },
    });
    expect(parsed.mcpServers?.weather.headers?.Authorization).toBe(
      'Bearer ${env.WEATHER_KEY}',
    );
  });

  it('rejects an unknown transport', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        bad: { url: 'https://x', transport: 'websocket' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed url', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        bad: { url: 'not-a-url' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields on an entry', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      mcpServers: {
        bad: { url: 'https://x', extra: 1 },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — tools gate', () => {
  it('accepts allowlist + denylist together', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      tools: {
        allowlist: ['ggui.suggest_ui', 'ggui.complete_ui'],
        denylist: ['ggui.dangerous_tool'],
      },
    });
    expect(parsed.tools?.allowlist).toHaveLength(2);
    expect(parsed.tools?.denylist).toHaveLength(1);
  });

  it('rejects an empty tool name', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      tools: { allowlist: [''] },
    });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — runtime knobs', () => {
  it('accepts maxTurns + env + temperature together', () => {
    const parsed = parseAgentJson({
      ...MINIMAL_V1,
      runtime: {
        maxTurns: 50,
        env: { LOG_LEVEL: 'debug' },
        temperature: 0.7,
      },
    });
    expect(parsed.runtime?.maxTurns).toBe(50);
    expect(parsed.runtime?.env?.LOG_LEVEL).toBe('debug');
    expect(parsed.runtime?.temperature).toBe(0.7);
  });

  it('rejects maxTurns below 1', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      runtime: { maxTurns: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects temperature above 2', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      runtime: { temperature: 3 },
    });
    expect(result.success).toBe(false);
  });
});

describe('agent.json schema — claude framework block', () => {
  it('accepts the three permission modes', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const parsed = parseAgentJson({
        ...MINIMAL_V1,
        claude: { permissions: { mode } },
      });
      expect(parsed.claude?.permissions?.mode).toBe(mode);
    }
  });

  it('rejects an unknown permission mode', () => {
    const result = safeParseAgentJson({
      ...MINIMAL_V1,
      claude: { permissions: { mode: 'yolo' } },
    });
    expect(result.success).toBe(false);
  });
});
