import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { cerebras } from '../../../src/cerebras/index.ts';
import type { CerebrasLLMParams } from '../../../src/cerebras/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { createAddTool, envModel } from '../../helpers/live.ts';

const HAS_CEREBRAS_KEY = Boolean(process.env.CEREBRAS_API_KEY);
const MODEL = envModel('CEREBRAS_TEST_MODEL', 'llama-3.3-70b');
const INVALID_MODEL = 'pp-nightly-invalid-model';

const STRUCTURE: JSONSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'confidence'],
  additionalProperties: false,
};

interface StructuredContract {
  verdict: string;
  confidence: number;
}

function isStructuredContract(value: unknown): value is StructuredContract {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.verdict === 'string' && typeof candidate.confidence === 'number';
}

function expectInvalidModelError(error: unknown): void {
  expect(error).toBeInstanceOf(UPPError);
  const uppError = error as UPPError;

  expect(uppError.provider).toBe('cerebras');
  const validCode = uppError.code === ErrorCode.InvalidRequest
    || uppError.code === ErrorCode.ModelNotFound
    || uppError.code === ErrorCode.ProviderError;
  expect(validCode).toBe(true);
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

describe.skipIf(!HAS_CEREBRAS_KEY)('Cerebras live nightly', () => {
  test('structured output returns schema-conformant data', async () => {
    const model = llm<CerebrasLLMParams>({
      model: cerebras(MODEL),
      structure: STRUCTURE,
      params: {
        max_completion_tokens: 180,
      },
    });

    const turn = await model.generate('Classify reliability as positive or negative. Return verdict and confidence.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
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
          'Call the add tool exactly once with a=2 and b=3. After the tool result, reply only with sum=5.'
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
  }, 90000);

  test('invalid model returns normalized error', async () => {
    const model = llm<CerebrasLLMParams>({
      model: cerebras(INVALID_MODEL),
      params: {
        max_completion_tokens: 24,
      },
    });

    let caughtError: unknown;
    try {
      await model.generate('Ping');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    expectInvalidModelError(caughtError);
  }, 90000);
});
