import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { groq } from '../../../src/groq/index.ts';
import type { GroqLLMParams } from '../../../src/groq/index.ts';
import { collectTextStream, createAddTool, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const MODEL = envModel(
  'GROQ_RELEASE_TEST_MODEL',
  envModel('GROQ_TEST_MODEL', 'llama-3.1-8b-instant'),
);

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_GROQ_ACCESS = hasProviderAccess(process.env.GROQ_API_KEY, MODEL);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_GROQ_ACCESS)('Release provider validation (Groq)', () => {
  test('generate and stream return deterministic arithmetic output', async () => {
    const model = llm<GroqLLMParams>({
      model: groq(MODEL),
      params: {
        max_tokens: 120,
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
  }, 90000);

  test('tool loop executes add tool and returns result', async () => {
    const model = llm<GroqLLMParams>({
      model: groq(MODEL),
      tools: [createAddTool()],
      params: {
        max_tokens: 220,
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
  }, 90000);
});
