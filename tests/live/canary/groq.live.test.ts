import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { groq } from '../../../src/groq/index.ts';
import type { GroqLLMParams } from '../../../src/groq/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_GROQ_KEY = Boolean(process.env.GROQ_API_KEY);
const MODEL = envModel('GROQ_TEST_MODEL', 'llama-3.1-8b-instant');

describe.skipIf(!HAS_GROQ_KEY)('Groq live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<GroqLLMParams>({
      model: groq(MODEL),
      params: {
        max_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<GroqLLMParams>({
      model: groq(MODEL),
      params: {
        max_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about reliable APIs.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
