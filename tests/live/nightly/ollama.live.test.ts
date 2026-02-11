import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { ollama } from '../../../src/ollama/index.ts';
import type { OllamaLLMParams } from '../../../src/ollama/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { createAddTool, envModel } from '../../helpers/live.ts';

const RUN_OLLAMA_LIVE = process.env.RUN_OLLAMA_LIVE === '1';
const MODEL = envModel('OLLAMA_TEST_MODEL', 'llama3.2');
const BASE_URL = process.env.OLLAMA_TEST_BASE_URL ?? 'http://localhost:11434';
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

  expect(uppError.provider).toBe('ollama');
  const validCode = uppError.code === ErrorCode.InvalidRequest
    || uppError.code === ErrorCode.ModelNotFound
    || uppError.code === ErrorCode.ProviderError;
  expect(validCode).toBe(true);
}

describe.skipIf(!RUN_OLLAMA_LIVE)('Ollama live nightly', () => {
  test('structured output returns schema-conformant data', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(MODEL),
      structure: STRUCTURE,
      config: {
        baseUrl: BASE_URL,
      },
      params: {
        num_predict: 512,
      },
    });

    const turn = await model.generate('Classify reliability as positive or negative. Return verdict and confidence.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
  }, 120000);

  test('tool loop executes add tool and returns result', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(MODEL),
      tools: [createAddTool()],
      config: {
        baseUrl: BASE_URL,
      },
      params: {
        num_predict: 220,
      },
    });

    const turn = await model.generate(
      'Call the add tool exactly once with a=2 and b=3. After the tool result, reply only with sum=5.'
    );

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 5 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('5');
  }, 120000);

  test('invalid model returns normalized error', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(INVALID_MODEL),
      config: {
        baseUrl: BASE_URL,
      },
      params: {
        num_predict: 24,
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
  }, 120000);
});
