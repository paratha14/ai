import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openrouter } from '../../../src/openrouter/index.ts';
import type { OpenRouterCompletionsParams } from '../../../src/openrouter/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_OPENROUTER_KEY = Boolean(process.env.OPENROUTER_API_KEY);
const MODEL = envModel('OPENROUTER_TEST_MODEL', 'openai/gpt-4o-mini');

describe.skipIf(!HAS_OPENROUTER_KEY)('OpenRouter live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(MODEL, { api: 'completions' }),
      params: {
        max_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 90000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(MODEL, { api: 'completions' }),
      params: {
        max_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about robust APIs.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
