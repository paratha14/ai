import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { xai } from '../../../src/xai/index.ts';
import type { XAICompletionsParams } from '../../../src/xai/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_XAI_KEY = Boolean(process.env.XAI_API_KEY);
const MODEL = envModel('XAI_TEST_MODEL', 'grok-4-1-fast-non-reasoning');

describe.skipIf(!HAS_XAI_KEY)('xAI live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<XAICompletionsParams>({
      model: xai(MODEL, { api: 'completions' }),
      params: {
        max_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 90000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<XAICompletionsParams>({
      model: xai(MODEL, { api: 'completions' }),
      params: {
        max_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about stable integrations.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
