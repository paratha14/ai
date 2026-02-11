import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const MODEL = envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini');

describe.skipIf(!HAS_OPENAI_KEY)('OpenAI live canary', () => {
  test('generate returns text using Responses API', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        max_output_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream returns events and final turn', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        max_output_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Explain in one sentence why stable APIs matter.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
