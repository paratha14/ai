import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { moonshot } from '../../../src/moonshot/index.ts';
import type { MoonshotLLMParams } from '../../../src/moonshot/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_MOONSHOT_KEY = Boolean(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY);
const MODEL = envModel('MOONSHOT_TEST_MODEL', 'kimi-k2.5');

describe.skipIf(!HAS_MOONSHOT_KEY)('Moonshot live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<MoonshotLLMParams>({
      model: moonshot(MODEL),
      params: {
        max_tokens: 120,
        thinking: { type: 'disabled' },
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 90000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<MoonshotLLMParams>({
      model: moonshot(MODEL),
      params: {
        max_tokens: 120,
        thinking: { type: 'disabled' },
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about consistent protocols.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
