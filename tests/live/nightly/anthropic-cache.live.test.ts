import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { anthropic } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { envModel } from '../../helpers/live.ts';

const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const RUN_ANTHROPIC_CACHE_LIVE = process.env.RUN_ANTHROPIC_CACHE_LIVE === '1';
const MODEL = envModel(
  'ANTHROPIC_CACHE_TEST_MODEL',
  envModel('ANTHROPIC_TEST_MODEL', 'claude-sonnet-4-20250514'),
);

const SHOULD_SKIP = !HAS_ANTHROPIC_KEY || !RUN_ANTHROPIC_CACHE_LIVE || MODEL.length === 0;
const CACHED_CONTEXT = Array.from(
  { length: 420 },
  (_, index) => `Cache clause ${index + 1}: the protocol adapter keeps provider behaviors consistent.`,
).join(' ');

describe.skipIf(SHOULD_SKIP)('Anthropic cache live nightly', () => {
  test('cache_control system prompt can be reused across turns', async () => {
    const model = llm<AnthropicLLMParams>({
      model: anthropic(MODEL),
      system: [
        {
          type: 'text',
          text: CACHED_CONTEXT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      params: {
        max_tokens: 120,
      },
    });

    const turn1 = await model.generate('Reply exactly with: CACHE_STAGE_ONE');
    const turn2 = await model.generate('Reply exactly with: CACHE_STAGE_TWO');

    expect(turn1.response.text).toContain('CACHE_STAGE_ONE');
    expect(turn2.response.text).toContain('CACHE_STAGE_TWO');

    const cacheSignal = turn1.usage.cacheWriteTokens > 0
      || turn2.usage.cacheReadTokens > 0
      || turn2.usage.cacheWriteTokens > 0;
    expect(cacheSignal).toBe(true);
  }, 120000);
});
