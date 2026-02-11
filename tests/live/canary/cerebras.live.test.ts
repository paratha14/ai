import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { cerebras } from '../../../src/cerebras/index.ts';
import type { CerebrasLLMParams } from '../../../src/cerebras/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_CEREBRAS_KEY = Boolean(process.env.CEREBRAS_API_KEY);
const MODEL = envModel('CEREBRAS_TEST_MODEL', 'llama-3.3-70b');

describe.skipIf(!HAS_CEREBRAS_KEY)('Cerebras live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<CerebrasLLMParams>({
      model: cerebras(MODEL),
      params: {
        max_completion_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<CerebrasLLMParams>({
      model: cerebras(MODEL),
      params: {
        max_completion_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about protocol stability.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
