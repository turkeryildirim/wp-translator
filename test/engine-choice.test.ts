import { describe, expect, it } from 'vitest';
import { providerFor } from '../src/server/translate.ts';

const noop = (): void => {};

describe('which CLI a run uses', () => {
  it('uses agy when the panel asked for agy', () => {
    // Reported from the panel: picking agy still translated through opencode.
    expect(providerFor({ engine: 'agy' }, noop).name).toBe('agy');
  });

  it('uses opencode when the panel asked for opencode', () => {
    expect(providerFor({ engine: 'opencode' }, noop).name).toBe('opencode');
  });

  it('falls back to opencode when nothing said which', () => {
    expect(providerFor({}, noop).name).toBe('opencode');
  });

  it('still uses agy when an opencode agent came along for the ride', () => {
    // The panel sends its engine arguments as a spread, so a stale `agent` from
    // the other engine must not decide this.
    expect(providerFor({ engine: 'agy', agent: 'wp-translator' }, noop).name).toBe('agy');
  });
});
