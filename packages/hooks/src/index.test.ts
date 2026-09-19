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
