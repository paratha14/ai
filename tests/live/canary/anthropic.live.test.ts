import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { anthropic } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = envModel('ANTHROPIC_TEST_MODEL', 'claude-3-5-haiku-latest');

describe.skipIf(!HAS_ANTHROPIC_KEY)('Anthropic live canary', () => {
  test('generate returns a non-empty response', async () => {
    const model = llm<AnthropicLLMParams>({
      model: anthropic(MODEL),
      params: {
        max_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<AnthropicLLMParams>({
      model: anthropic(MODEL),
      params: {
        max_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with a short sentence about reliability.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
