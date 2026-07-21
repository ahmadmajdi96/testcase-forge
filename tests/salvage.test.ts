import { describe, expect, it } from 'vitest';
import { RawBatch } from '../src/coverage/normalize.js';
import { parseBatch, salvageObjects } from '../src/llm/parse.js';

describe('tolerant batch parsing', () => {
  it('parses a clean batch', () => {
    const out = parseBatch(JSON.stringify({ testCases: [{ a: 1 }, { a: 2 }] }));
    expect(out.testCases).toHaveLength(2);
  });

  it('strips code fences', () => {
    const out = parseBatch('```json\n{"testCases":[{"a":1}]}\n```');
    expect(out.testCases).toHaveLength(1);
  });

  it('salvages complete objects from a truncated array', () => {
    // Two complete objects then a truncated third (token limit hit mid-array).
    const truncated =
      '{"testCases":[{"title":"one","steps":[]},{"title":"two","steps":[]},{"title":"thr';
    const out = parseBatch(truncated);
    expect(out.testCases).toHaveLength(2);
    expect((out.testCases[0] as { title: string }).title).toBe('one');
  });

  it('ignores braces and brackets inside strings', () => {
    const out = parseBatch('{"testCases":[{"title":"a } { b","steps":[]}]}');
    expect(out.testCases).toHaveLength(1);
    expect((out.testCases[0] as { title: string }).title).toBe('a } { b');
  });

  it('handles escaped quotes inside strings', () => {
    const objs = salvageObjects('[{"t":"he said \\"hi\\" }"}]');
    expect(objs).toHaveLength(1);
    expect((objs[0] as { t: string }).t).toBe('he said "hi" }');
  });

  it('produces RawBatch-valid output', () => {
    const out = parseBatch('{"testCases":[{"title":"x"}]}');
    const parsed = RawBatch.safeParse(out);
    expect(parsed.success).toBe(true);
  });

  it('throws only when nothing is recoverable', () => {
    expect(() => parseBatch('the model refused to answer')).toThrow(/recoverable/i);
  });
});
