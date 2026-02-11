import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { cerebras } from '../../../src/cerebras/index.ts';
import type { CerebrasLLMParams } from '../../../src/cerebras/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import { collectTextStream, createAddTool, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const MODEL = envModel(
  'CEREBRAS_RELEASE_TEST_MODEL',
  envModel('CEREBRAS_TEST_MODEL', 'llama-3.3-70b'),
);

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

function isRetryableToolLoopError(error: unknown): boolean {
  if (!(error instanceof UPPError)) {
    return false;
  }

  if (error.code === ErrorCode.RateLimited) {
    return true;
  }

  return error.code === ErrorCode.InvalidRequest
    && error.message.includes('Tool execution exceeded maximum iterations');
}

const HAS_CEREBRAS_ACCESS = hasProviderAccess(process.env.CEREBRAS_API_KEY, MODEL);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_CEREBRAS_ACCESS)('Release provider validation (Cerebras)', () => {
  test('generate and stream return deterministic arithmetic output', async () => {
    const model = llm<CerebrasLLMParams>({
      model: cerebras(MODEL),
      params: {
        max_completion_tokens: 120,
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
    const model = llm<CerebrasLLMParams>({
      model: cerebras(MODEL),
      tools: [createAddTool()],
      params: {
        max_completion_tokens: 220,
      },
    });

    let turn: Awaited<ReturnType<typeof model.generate>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        turn = await model.generate(
          'Call the add tool exactly once with a=2 and b=3. After the tool result, reply only with sum=5.',
        );
        break;
      } catch (error) {
        if (!isRetryableToolLoopError(error) || attempt === 2) {
          throw error;
        }
        await Bun.sleep(1500);
      }
    }

    if (!turn) {
      throw new Error('Expected a turn from Cerebras tool execution contract');
    }

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 5 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('5');
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 90000);
});
