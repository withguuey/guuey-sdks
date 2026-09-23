/**
 * The CLI's one home for "who is this agent for" (guuey#1670): the ruled
 * question, the console's two answers, the `--for` flag and the deploy
 * prompt's answer parser.
 */
import { describe, expect, it } from 'vitest';
import { APP_BUILT_FOR } from '@guuey/config';
import {
  BUILT_FOR_ASK,
  BUILT_FOR_CHOICES,
  BUILT_FOR_LABEL,
  BUILT_FOR_QUESTION,
  BUILT_FOR_RETRY,
  isAppBuiltFor,
  parseBuiltForAnswer,
  parseBuiltForFlag,
} from './built-for';

describe('the question and its answers', () => {
  it('asks the ruled question, word for word (his 2026-09-23 copy)', () => {
    expect(BUILT_FOR_QUESTION).toBe('Is this agent for you, or for your customers?');
  });

  it("labels exactly the stored values, in the console's words", () => {
    expect(Object.keys(BUILT_FOR_LABEL).sort()).toEqual([...APP_BUILT_FOR].sort());
    expect(BUILT_FOR_LABEL).toEqual({ personal: 'Just for me', customers: 'For my customers' });
  });

  it('the prompt shows the question, then 1) personal and 2) customers, and offers no default', () => {
    expect(BUILT_FOR_CHOICES.split('\n')).toEqual([
      '  Is this agent for you, or for your customers?',
      '    1) Just for me',
      '    2) For my customers',
    ]);
    expect(BUILT_FOR_ASK).not.toMatch(/\[/); // no "[default]" bracket
    expect(BUILT_FOR_RETRY).toContain('1 (just for me)');
    expect(BUILT_FOR_RETRY).toContain('2 (for my customers)');
  });
});

describe('parseBuiltForFlag (--for)', () => {
  it('absent is undefined: no key is sent and nothing is guessed', () => {
    expect(parseBuiltForFlag(undefined)).toBeUndefined();
  });

  it('takes each stored value as written', () => {
    for (const v of APP_BUILT_FOR) expect(parseBuiltForFlag(v)).toBe(v);
  });

  it('refuses a valueless --for, naming both values', () => {
    expect(() => parseBuiltForFlag(true)).toThrow(/--for needs a value.*--for personal.*--for customers/);
  });

  it('refuses anything else, naming what it got and both values', () => {
    expect(() => parseBuiltForFlag('team')).toThrow('Unknown --for "team". Use --for personal (just for you) or --for customers (for your customers).');
    expect(() => parseBuiltForFlag('Personal')).toThrow(/Unknown --for "Personal"/);
    expect(() => parseBuiltForFlag('')).toThrow(/Unknown --for ""/);
  });
});

describe('parseBuiltForAnswer (the deploy prompt)', () => {
  it('takes the choice number', () => {
    expect(parseBuiltForAnswer('1')).toBe('personal');
    expect(parseBuiltForAnswer('2')).toBe('customers');
  });

  it('takes the value name, ignoring case and surrounding spaces', () => {
    expect(parseBuiltForAnswer('  Personal ')).toBe('personal');
    expect(parseBuiltForAnswer('CUSTOMERS')).toBe('customers');
  });

  it('returns undefined for an empty or unknown answer, so the prompt asks again', () => {
    for (const a of ['', '   ', '3', '0', 'yes', 'me', '1 2']) expect(parseBuiltForAnswer(a)).toBeUndefined();
  });
});

describe('isAppBuiltFor', () => {
  it('is exactly the APP_BUILT_FOR membership test', () => {
    for (const v of APP_BUILT_FOR) expect(isAppBuiltFor(v)).toBe(true);
    for (const v of ['', 'Personal', 'team', 'customer']) expect(isAppBuiltFor(v)).toBe(false);
  });
});
