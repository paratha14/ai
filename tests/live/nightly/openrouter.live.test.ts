import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openrouter } from '../../../src/openrouter/index.ts';
import type {
  OpenRouterCompletionsParams,
  OpenRouterResponsesParams,
} from '../../../src/openrouter/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { collectTextStream, createAddTool, envModel } from '../../helpers/live.ts';

const HAS_OPENROUTER_KEY = Boolean(process.env.OPENROUTER_API_KEY);
const MODEL = envModel('OPENROUTER_TEST_MODEL', 'openai/gpt-4o-mini');
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

  expect(uppError.provider).toBe('openrouter');
  const validCode = uppError.code === ErrorCode.InvalidRequest
    || uppError.code === ErrorCode.ModelNotFound
    || uppError.code === ErrorCode.ProviderError;
  expect(validCode).toBe(true);
}

describe.skipIf(!HAS_OPENROUTER_KEY)('OpenRouter live nightly', () => {
  test('completions mode structured output returns schema-conformant data', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(MODEL, { api: 'completions' }),
      structure: STRUCTURE,
      params: {
        max_tokens: 180,
      },
    });

    const turn = await model.generate('Classify reliability as positive or negative. Return verdict and confidence.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
  }, 90000);

  test('completions mode tool loop executes add tool and returns result', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(MODEL, { api: 'completions' }),
      tools: [createAddTool()],
      params: {
        max_tokens: 220,
      },
    });

    const turn = await model.generate(
      'Call the add tool exactly once with a=2 and b=3. After the tool result, reply only with sum=5.'
    );

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 5 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('5');
  }, 90000);

  test('invalid model returns normalized error', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(INVALID_MODEL, { api: 'completions' }),
      params: {
        max_tokens: 24,
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

  test('responses mode stream succeeds', async () => {
    const model = llm<OpenRouterResponsesParams>({
      model: openrouter(MODEL, { api: 'responses' }),
      params: {
        max_output_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Provide one sentence about API drift checks.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
