import { describe, expect, it } from 'vitest';
import { chunk } from '../src/server/translate.ts';

const unit = (msgid: string, msgidPlural?: string) => ({ msgid, ...(msgidPlural ? { msgidPlural } : {}) });
const sizes = (batches: { msgid: string }[][]) =>
  batches.map((batch) => batch.reduce((n, u) => n + u.msgid.length, 0));

describe('splitting units into requests', () => {
  it('closes a batch on the character budget, not only the count', () => {
    // Measured: ten readme paragraphs are 6 038 characters of source and take
    // 174 s to answer, past the 120 s a request is given. Ten interface labels
    // are a couple of hundred and answer in seconds. The count cannot tell them
    // apart, so the length has to.
    const long = Array.from({ length: 10 }, () => unit('x'.repeat(600)));

    expect(chunk(long, 10, 2_000).length).toBe(4);
    expect(sizes(chunk(long, 10, 2_000)).every((n) => n <= 2_000)).toBe(true);
  });

  it('still closes on the count when the strings are short', () => {
    const short = Array.from({ length: 25 }, () => unit('Kaydet'));

    expect(chunk(short, 10, 2_000).map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it('sends a string longer than the whole budget on its own', () => {
    const units = [unit('a'.repeat(5_000)), unit('b'), unit('c')];
    const batches = chunk(units, 10, 2_000);

    expect(batches[0]!.length).toBe(1);
    expect(batches[1]!.map((u) => u.msgid)).toEqual(['b', 'c']);
  });

  it('counts the plural form too, because it is translated as well', () => {
    const units = [unit('x'.repeat(900), 'y'.repeat(900)), unit('z'.repeat(900))];

    expect(chunk(units, 10, 2_000).length).toBe(2);
  });

  it('loses nothing and reorders nothing', () => {
    const units = Array.from({ length: 17 }, (_, n) => unit(`s${n}`.repeat(70)));
    const flat = chunk(units, 4, 500).flat();

    expect(flat).toEqual([...units]);
  });

  it('gives back nothing for nothing', () => {
    expect(chunk([], 10, 2_000)).toEqual([]);
  });
});
