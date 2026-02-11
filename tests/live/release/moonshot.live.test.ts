import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { moonshot } from '../../../src/moonshot/index.ts';
import type { MoonshotLLMParams } from '../../../src/moonshot/index.ts';
import { collectTextStream, createAddTool, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const MODEL = envModel(
  'MOONSHOT_RELEASE_TEST_MODEL',
  envModel('MOONSHOT_TEST_MODEL', 'kimi-k2.5'),
);

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_MOONSHOT_ACCESS = hasProviderAccess(
  process.env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY,
  MODEL,
);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_MOONSHOT_ACCESS)('Release provider validation (Moonshot)', () => {
  test('generate and stream return deterministic arithmetic output', async () => {
    const model = llm<MoonshotLLMParams>({
      model: moonshot(MODEL),
      params: {
        max_tokens: 120,
        thinking: { type: 'disabled' },
      },
    });

    const prompt = 'Compute 19 + 23. Return only the final integer.';
    const generatedTurn = await model.generate(prompt);
    const streamed = await collectTextStream(model.stream(prompt));

    expect(generatedTurn.response.text).toMatch(/\b42\b/);
    expect(generatedTurn.usage.totalTokens).toBeGreaterThan(0);
    expect(streamed.eventCount).toBeGreaterThan(0);
    expect(streamed.turn.response.text).toMatch(/\b42\b/);
    expect(streamed.turn.usage.totalTokens).toBeGreaterThan(0);
  }, 120000);

  test('tool loop executes add tool and returns result', async () => {
    const model = llm<MoonshotLLMParams>({
      model: moonshot(MODEL),
      tools: [createAddTool()],
      params: {
        max_tokens: 220,
        thinking: { type: 'disabled' },
      },
    });

    const turn = await model.generate(
      'Call the add tool exactly once with a=2 and b=3. After the tool result, reply only with sum=5.',
    );

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 5 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('5');
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 120000);
});
