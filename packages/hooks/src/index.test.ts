import { describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS,
  HOOK_EVENT_NAMES,
  PREBUILT_HOOKS,
  RESERVED_SESSION_EVENT_NAMES,
  hookDefinitionSchema,
  hookEventSchema,
  hookResultSchema,
  hooksSectionSchema,
  toWireToolName,
  toolPatternCovers,
  CONVERSATION_REPORT_JSON_SCHEMA,
  HOOK_DOOR_PATH,
  PREBUILT_DEFINITIONS,
  conversationReportSchema,
  hookInvokeRequestSchema,
  hookInvokeResultSchema,
  isPrebuiltHookName,
  jsonObjectSchema,
  prebuiltBinding,
  type HookEvent,
  type HookEventName,
} from './index.js';

const AT = '2026-09-19T09:00:00.000Z';
const base = { id: 'evt_1', at: AT, appId: 'app_1', threadId: 't_1', hook: { name: 'email-reporter', runId: 'run_1' } };

describe('the per-event table (§8.1)', () => {
  it('names every event exactly once and fires exactly two in v1', () => {
    expect(Object.keys(HOOK_EVENTS).sort()).toEqual([...HOOK_EVENT_NAMES].sort());
    expect(HOOK_EVENT_NAMES.filter((n) => HOOK_EVENTS[n].firedInV1)).toEqual(['session.ended', 'handoff.requested']);
  });
  it('the reserved session-event tuple is the table, read the other way', () => {
    expect([...RESERVED_SESSION_EVENT_NAMES]).toEqual(
      HOOK_EVENT_NAMES.filter((n) => !HOOK_EVENTS[n].firedInV1 && HOOK_EVENTS[n].scope === 'session'),
    );
  });
  it('schedules are app-scoped; every other event names a session', () => {
    expect(HOOK_EVENTS['schedule.tick'].scope).toBe('app');
    expect(HOOK_EVENT_NAMES.filter((n) => HOOK_EVENTS[n].scope === 'app')).toEqual(['schedule.tick']);
  });
  it('a dormant conversation cannot be appended to; only the reserved decide-class event is blockable', () => {
    expect(HOOK_EVENTS['session.ended'].allowsAppend).toBe(false);
    expect(HOOK_EVENT_NAMES.filter((n) => HOOK_EVENTS[n].blockable)).toEqual(['turn.start']);
    expect(HOOK_EVENTS['turn.start'].class).toBe('decide');
  });
  it('the v1 prebuilt catalog is the email reporter', () => {
    expect(PREBUILT_HOOKS).toEqual(['email-reporter']);
  });
});

describe('the envelope (§8.2)', () => {
  it('parses a session.ended event with its data', () => {
    const ev = hookEventSchema.parse({
      ...base,
      type: 'session.ended',
      data: { reason: 'idle', idleMinutes: 15, lastActivityAt: AT, turns: 7 },
    });
    expect(ev.type).toBe('session.ended');
    if (ev.type === 'session.ended') expect(ev.data.idleMinutes).toBe(15);
  });
  it('parses a handoff.requested event and refuses an unknown data key', () => {
    expect(
      hookEventSchema.parse({ ...base, type: 'handoff.requested', data: { question: 'Do you ship to Iceland?', summary: 's' } }).type,
    ).toBe('handoff.requested');
    expect(hookEventSchema.safeParse({ ...base, type: 'handoff.requested', data: { question: 'q', junk: 1 } }).success).toBe(false);
  });
  it('a schedule tick binds to the app alone — no threadId — and names its schedule', () => {
    const { threadId: _omit, ...appOnly } = { ...base, threadId: 't_1' };
    const ev = hookEventSchema.parse({ ...appOnly, type: 'schedule.tick', data: { schedule: 'daily-digest', scheduledFor: AT } });
    expect(ev.type).toBe('schedule.tick');
    expect('threadId' in ev).toBe(false);
    expect(hookEventSchema.safeParse({ ...base, type: 'schedule.tick', data: { schedule: 'daily-digest', scheduledFor: AT } }).success).toBe(false);
  });
  it('reserved events carry an opaque JSON payload; an unknown type is refused', () => {
    expect(hookEventSchema.safeParse({ ...base, type: 'turn.completed', data: { anything: [1, 'two', null] } }).success).toBe(true);
    expect(hookEventSchema.safeParse({ ...base, type: 'made.up', data: {} }).success).toBe(false);
  });
});

describe('the result (§8.2, §8.9)', () => {
  it('defaults effects to [] and keeps note/append optional', () => {
    const r = hookResultSchema.parse({ status: 'ok', output: { summary: 'x' } });
    expect(r.effects).toEqual([]);
    expect(r.note).toBeUndefined();
  });
  it('an effect names its tool as "<server>.<tool>"', () => {
    expect(hookResultSchema.safeParse({ status: 'ok', effects: [{ tool: 'email-reporter.report_conversation', status: 'enforced' }] }).success).toBe(true);
    expect(hookResultSchema.safeParse({ status: 'ok', effects: [{ tool: 'report_conversation', status: 'called' }] }).success).toBe(false);
  });
});

describe('the guuey.json block (§8.7)', () => {
  const block = {
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
  it('parses the spec example', () => {
    expect(hooksSectionSchema.safeParse(block).success).toBe(true);
  });
  it('an agent ref must name a declared definition that is on that event', () => {
    const missing = { ...block, 'session.ended': [{ kind: 'agent', definition: 'nope' }] };
    expect(hooksSectionSchema.safeParse(missing).success).toBe(false);
    const wrongEvent = { ...block, 'handoff.requested': [{ kind: 'agent', definition: 'nightly-triage' }] };
    const res = hooksSectionSchema.safeParse(wrongEvent);
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]?.message).toContain('not declared for handoff.requested');
  });
  it('reserved events cannot carry handlers in v1 — nor can schedules, until schedule.tick fires', () => {
    expect(hooksSectionSchema.safeParse({ 'turn.completed': [{ use: 'email-reporter' }] }).success).toBe(false);
    expect(
      hooksSectionSchema.safeParse({ schedules: { 'daily-digest': { cron: '0 9 * * *', handlers: [{ use: 'email-reporter' }] } } }).success,
    ).toBe(false);
  });
  it('actAs is the hook principal only; a required tool must be inside the allowlist', () => {
    expect(hookDefinitionSchema.safeParse({ kind: 'agent', on: ['session.ended'], instruction: 'x', actAs: 'visitor' }).success).toBe(false);
    expect(hookDefinitionSchema.safeParse({ kind: 'agent', on: ['session.ended'], instruction: 'x', actAs: 'hook' }).success).toBe(true);
    const r = hookDefinitionSchema.safeParse({ kind: 'agent', on: ['session.ended'], instruction: 'x', tools: ['a.*'], required: ['b.c'] });
    expect(r.success).toBe(false);
  });
  it('a tool definition names exactly one tool', () => {
    expect(hookDefinitionSchema.safeParse({ kind: 'tool', on: ['handoff.requested'], tool: 'my-crm.create_lead' }).success).toBe(true);
    expect(hookDefinitionSchema.safeParse({ kind: 'tool', on: ['handoff.requested'] }).success).toBe(false);
  });
  it('an unknown key is refused (strict) — the block is a wire the previous release did not send', () => {
    expect(hooksSectionSchema.safeParse({ ...block, extra: 1 }).success).toBe(false);
  });
});

describe('tool names', () => {
  it('maps config names to the wire name the runtime extractor matches', () => {
    expect(toWireToolName('email-reporter.report_conversation')).toBe('mcp__email-reporter__report_conversation');
    expect(toWireToolName('guuey-handoff.request_human')).toBe('mcp__guuey-handoff__request_human');
    expect(() => toWireToolName('request_human')).toThrow(/<server>\.<tool>/);
  });
  it('patterns cover exact names or a whole server', () => {
    expect(toolPatternCovers('my-crm.*', 'my-crm.create_lead')).toBe(true);
    expect(toolPatternCovers('my-crm.create_lead', 'my-crm.create_lead')).toBe(true);
    expect(toolPatternCovers('my-crm.*', 'other.create_lead')).toBe(false);
    expect(toolPatternCovers('my-crm.x', 'my-crm.create_lead')).toBe(false);
  });
});

describe('the agent definition\'s `output` (a JSON Schema for the structured output)', () => {
  it('parses as any JSON value and stays optional (a definition without it is free-form)', () => {
    const base = { kind: 'agent', on: ['session.ended'], instruction: 'x' };
    expect(hookDefinitionSchema.safeParse(base).success).toBe(true);
    expect(hookDefinitionSchema.safeParse({ ...base, output: CONVERSATION_REPORT_JSON_SCHEMA }).success).toBe(true);
    expect(hookDefinitionSchema.safeParse({ ...base, output: { type: 'object', properties: { when: new Date(0) } } }).success).toBe(false);
  });
});

describe('the runtime door wire (§8.4)', () => {
  const event: HookEvent = {
    id: 't-1#session.ended#2026-09-19T11:40:00.000Z',
    at: '2026-09-19T12:00:00.000Z',
    appId: 'app-1',
    threadId: 't-1',
    type: 'session.ended',
    hook: { name: 'email-reporter', runId: 'r-1' },
    data: { reason: 'idle', idleMinutes: 15, lastActivityAt: '2026-09-19T11:40:00.000Z', turns: 4 },
  };
  it('the request is exactly { runId, name, event, timeoutMs } — strict, timeoutMs a bounded number', () => {
    expect(HOOK_DOOR_PATH).toBe('/agent/hook');
    expect(hookInvokeRequestSchema.safeParse({ runId: 'r-1', name: 'email-reporter', event, timeoutMs: 90_000 }).success).toBe(true);
    expect(hookInvokeRequestSchema.safeParse({ runId: 'r-1', name: 'email-reporter', event }).success).toBe(false);
    expect(hookInvokeRequestSchema.safeParse({ runId: 'r-1', name: 'email-reporter', event, timeoutMs: 300_001 }).success).toBe(false);
    expect(hookInvokeRequestSchema.safeParse({ runId: 'r-1', name: 'email-reporter', event, timeoutMs: 90_000, tools: ['a.b'] }).success).toBe(false);
    expect(hookInvokeRequestSchema.safeParse({ runId: 'r-1', name: 'Not A Slug', event, timeoutMs: 90_000 }).success).toBe(false);
  });
  it('the result is ok|failed with effects called|failed|missing (default []), an optional JSON output and error — accepted/skipped/enforced are off the wire', () => {
    expect(hookInvokeResultSchema.parse({ runId: 'r-1', status: 'ok', output: { summary: 's' } })).toEqual({ runId: 'r-1', status: 'ok', output: { summary: 's' }, effects: [] });
    expect(hookInvokeResultSchema.safeParse({ runId: 'r-1', status: 'ok', effects: [{ tool: 'crm.log_lead', status: 'missing' }] }).success).toBe(true);
    expect(hookInvokeResultSchema.safeParse({ runId: 'r-1', status: 'accepted' }).success).toBe(false);
    expect(hookInvokeResultSchema.safeParse({ runId: 'r-1', status: 'skipped' }).success).toBe(false);
    expect(hookInvokeResultSchema.safeParse({ runId: 'r-1', status: 'ok', effects: [{ tool: 'crm.log_lead', status: 'enforced' }] }).success).toBe(false);
    expect(hookInvokeResultSchema.safeParse({ status: 'ok' }).success).toBe(false);
    // Additive pod-side fields pass through (a reader never refuses a key the other side started sending).
    expect(hookInvokeResultSchema.safeParse({ runId: 'r-1', status: 'ok', stopReason: 'end_turn', timedOut: false }).success).toBe(true);
    // Ids: a 128-char threadId, an instant and a 64-char hook name fit (the old 128 cap refused valid ids).
    const longRun = `${'t'.repeat(128)}#session.ended#2026-09-19T11:40:00.000Z#${'h'.repeat(64)}`;
    expect(longRun.length).toBeGreaterThan(128);
    expect(hookInvokeRequestSchema.safeParse({ runId: longRun, name: 'email-reporter', event: { ...event, hook: { name: 'email-reporter', runId: longRun } }, timeoutMs: 90_000 }).success).toBe(true);
    expect(jsonObjectSchema.safeParse({ a: [1, 'b', null] }).success).toBe(true);
    expect(jsonObjectSchema.safeParse('s').success).toBe(false);
    expect(jsonObjectSchema.safeParse([]).success).toBe(false);
  });
});

describe('the prebuilt catalog (§8.8, guuey#1537)', () => {
  const handoff: HookEvent = {
    id: 't-1#handoff.requested#7',
    at: '2026-09-19T12:00:00.000Z',
    appId: 'app-1',
    threadId: 't-1',
    type: 'handoff.requested',
    hook: { name: 'email-reporter', runId: 'r-1' },
    data: { question: 'Do you ship to Iceland?', contactEmail: 'v@example.com', contactName: 'Ada', summary: 'Asked about Iceland.' },
  };
  it('every catalog name has bindings only on events v1 fires; each agent binding\'s definition validates and is tool-less with an output schema', () => {
    for (const name of PREBUILT_HOOKS) {
      expect(isPrebuiltHookName(name)).toBe(true);
      for (const [event, binding] of Object.entries(PREBUILT_DEFINITIONS[name])) {
        expect(HOOK_EVENTS[event as HookEventName].firedInV1).toBe(true);
        if (binding?.kind === 'agent') {
          expect(hookDefinitionSchema.safeParse(binding.definition).success).toBe(true);
          expect(binding.definition.on).toContain(event);
          expect(binding.definition.tools).toBeUndefined();
          expect(binding.definition.required).toBeUndefined();
          expect(binding.definition.output).toBeDefined();
          expect(binding.effects.length).toBeGreaterThan(0);
        }
      }
    }
    expect(isPrebuiltHookName('nope')).toBe(false);
  });
  it('email-reporter on handoff.requested is ONE tool call that maps the envelope onto report_conversation\'s input (the rep\'s summary, else the question; wantedHuman true; the contact fields)', () => {
    const binding = prebuiltBinding('email-reporter', 'handoff.requested');
    expect(binding?.kind).toBe('tool');
    if (binding?.kind !== 'tool') return;
    expect(binding).toMatchObject({ serverId: 'email-reporter', tool: 'report_conversation' });
    const args = binding.args(handoff);
    expect(args).toEqual({ summary: 'Asked about Iceland.', wantedHuman: true, contactEmail: 'v@example.com', contactName: 'Ada' });
    expect(conversationReportSchema.safeParse(args).success).toBe(true);
    const noSummary: HookEvent = { ...handoff, data: { question: 'Do you ship to Iceland?' } };
    expect(binding.args(noSummary)).toEqual({ summary: 'Do you ship to Iceland?', wantedHuman: true });
    // Not this event's envelope → nothing to report.
    const ended: HookEvent = { ...handoff, type: 'session.ended', data: { reason: 'idle', idleMinutes: 15, lastActivityAt: '2026-09-19T11:40:00.000Z', turns: 4 } };
    expect(binding.args(ended)).toBeUndefined();
  });
  it('email-reporter on session.ended is a tool-less agent whose output IS the report, and one platform-made effect: report_conversation on the hosted reporter', () => {
    const binding = prebuiltBinding('email-reporter', 'session.ended');
    expect(binding?.kind).toBe('agent');
    if (binding?.kind !== 'agent') return;
    expect(binding.definition).toMatchObject({ kind: 'agent', on: ['session.ended'], model: 'small', maxTurns: 2, timeoutMs: 90_000, output: CONVERSATION_REPORT_JSON_SCHEMA });
    expect(binding.effects).toEqual([{ serverId: 'email-reporter', tool: 'report_conversation' }]);
    // The output schema and the tool's input agree on the required key.
    expect(CONVERSATION_REPORT_JSON_SCHEMA['required']).toEqual(['summary', 'wantedHuman']);
    expect(conversationReportSchema.safeParse({ summary: 's', wantedHuman: false }).success).toBe(true);
    expect(conversationReportSchema.safeParse({ wantedHuman: false }).success).toBe(false);
    expect(prebuiltBinding('email-reporter', 'turn.start')).toBeUndefined();
  });
});
