import { describe, expect, test } from 'bun:test';
import { parsePartialJson } from '../../../../src/utils/partial-json.ts';

interface ContractObject {
  name: string;
  score: number;
}

describe('Partial JSON contracts', () => {
  test('parses complete JSON as complete payload', () => {
    const result = parsePartialJson<ContractObject>('{"name":"Casey","score":9}');

    expect(result.isComplete).toBe(true);
    expect(result.value).toEqual({ name: 'Casey', score: 9 });
  });

  test('recovers nested incomplete objects during streaming', () => {
    const result = parsePartialJson('{"user":{"first":"Al","last":"Jo');

    expect(result.isComplete).toBe(false);
    expect(result.value).toEqual({
      user: { first: 'Al', last: 'Jo' },
    });
  });

  test('repairs incomplete primitives and trailing punctuation', () => {
    const boolResult = parsePartialJson('{"ok":tr');
    const numberResult = parsePartialJson('{"count":12.');
    const trailingColonResult = parsePartialJson('{"ok":true,"next":');

    expect(boolResult.value).toEqual({ ok: true });
    expect(numberResult.value).toEqual({ count: 12 });
    expect(trailingColonResult.value).toEqual({ ok: true });
  });

  test('handles incomplete escape sequences in strings', () => {
    const unicodeResult = parsePartialJson('{"text":"hello\\u00');
    const trailingEscapeResult = parsePartialJson('{"text":"hello\\');

    expect(unicodeResult.value).toEqual({ text: 'hello' });
    expect(trailingEscapeResult.value).toEqual({ text: 'hello' });
  });

  test('returns undefined value for irreparable malformed input', () => {
    const result = parsePartialJson('{{{');

    expect(result.isComplete).toBe(false);
    expect(result.value).toBeUndefined();
  });
});
