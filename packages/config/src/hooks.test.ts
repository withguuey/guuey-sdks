/**
 * guuey#1528 — the `hooks` block rides `guuey.json` through `@guuey/config`
 * (guuey#1511 §8.7): the spec example parses, a document without the block is
 * unchanged, and the v1 refusals (a reserved event, `actAs: 'visitor'`) surface
 * from the strict parse rather than silently passing.
 */
import { describe, expect, it } from 'vitest';
import { newRepDefaultHooks } from './agent.js';
import { parseGuueyJson, safeParseGuueyJson } from './schema.js';

const minimal = {
  schema: '1',
  agent: { framework: 'claude-agent-sdk' },
};

const hooks = {
  'session.ended': [{ use: 'email-reporter' }],
  'handoff.requested': [{ use: 'email-reporter' }, { kind: 'tool', server: 'my-crm', tool: 'create_lead' }],
  definitions: {
    'nightly-triage': {
      kind: 'agent',
      on: ['session.ended'],
      instruction: 'Summarize and file.',
      tools: ['my-crm.*'],
      required: ['my-crm.create_lead'],
      model: 'small',
      maxTurns: 4,
      timeoutMs: 60_000,
    },
  },
};

describe('guuey.json agent.hooks (guuey#1511 §8.7)', () => {
  it('parses the spec example and keeps it on the agent', () => {
    const doc = parseGuueyJson({ ...minimal, agent: { ...minimal.agent, hooks } });
    expect(doc.agent.hooks?.['session.ended']).toEqual([{ use: 'email-reporter' }]);
    expect(doc.agent.hooks?.definitions?.['nightly-triage']?.kind).toBe('agent');
  });

  it('a document without hooks parses as before — the block is optional both ways', () => {
    const doc = parseGuueyJson(minimal);
    expect(doc.agent.hooks).toBeUndefined();
  });

  it('a reserved event and actAs: visitor are refused by the strict parse', () => {
    expect(safeParseGuueyJson({ ...minimal, agent: { ...minimal.agent, hooks: { 'turn.completed': [{ use: 'email-reporter' }] } } }).success).toBe(false);
    expect(
      safeParseGuueyJson({
        ...minimal,
        agent: {
          ...minimal.agent,
          hooks: {
            'session.ended': [{ kind: 'agent', definition: 'x' }],
            definitions: { x: { kind: 'agent', on: ['session.ended'], instruction: 'i', tools: [], actAs: 'visitor' } },
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('newRepDefaultHooks (guuey#1738): what a NEW no-code rep starts with', () => {
  it('is exactly the email reporter on session.ended, nothing on handoff.requested (the notifier mails hand-offs)', () => {
    expect(newRepDefaultHooks()).toEqual({ 'session.ended': [{ use: 'email-reporter' }] });
  });

  it('parses as a declarative rep\'s hooks block under the strict schema', () => {
    const doc = parseGuueyJson({ schema: '1', agent: { mode: 'declarative', hooks: newRepDefaultHooks() } });
    expect(doc.agent.hooks).toEqual(newRepDefaultHooks());
  });

  it('hands every caller a fresh object: one snapshot mutating its copy never changes the next rep\'s default', () => {
    const first = newRepDefaultHooks();
    first['session.ended']?.push({ kind: 'tool', server: 'my-crm', tool: 'create_lead' });
    expect(newRepDefaultHooks()).toEqual({ 'session.ended': [{ use: 'email-reporter' }] });
  });
});
