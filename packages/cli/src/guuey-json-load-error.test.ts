import { describe, expect, it } from 'vitest';
import { parseGuueyJson } from '@guuey/config';
import { guueyJsonLoadErrorMessage, unknownKeyHint } from './guuey-json-load-error';

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('guueyJsonLoadErrorMessage (guuey#2851)', () => {
  it('keeps the strict refusal and adds one hint line naming the unknown key', () => {
    const err = thrownBy(() => parseGuueyJson({ schema: '1', agent: {}, app: { acess: {} } }));
    const message = guueyJsonLoadErrorMessage(err);
    expect(message.startsWith(err instanceof Error ? err.message : '')).toBe(true);
    expect(message.split('\n').at(-1)).toBe(unknownKeyHint(['app.acess']));
  });

  it('names every unknown key, plural wording', () => {
    expect(unknownKeyHint(['app.a', 'agent.b'])).toBe(
      'Unknown keys in guuey.json: app.a, agent.b. If they are typos, fix them; if they come from a newer guuey.json, upgrade @guuey/cli (npm i -g @guuey/cli@latest).',
    );
  });

  it('leaves any other error as it was', () => {
    const err = thrownBy(() => parseGuueyJson({ schema: '1', agent: {}, protocol: 'ag-ui' }));
    expect(guueyJsonLoadErrorMessage(err)).toBe(err instanceof Error ? err.message : '');
    expect(guueyJsonLoadErrorMessage(new Error('guuey.json not found at /x'))).toBe('guuey.json not found at /x');
    expect(guueyJsonLoadErrorMessage('plain')).toBe('plain');
  });
});
