import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { ollama } from '../../../src/ollama/index.ts';
import type { OllamaLLMParams } from '../../../src/ollama/index.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { createAddTool, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const HAS_OLLAMA_ENV = Boolean(process.env.OLLAMA_TEST_MODEL || process.env.OLLAMA_TEST_HOST);
const OLLAMA_MODEL = envModel(
  'OLLAMA_RELEASE_TEST_MODEL',
  envModel('OLLAMA_TEST_MODEL', 'llama3.2'),
);
const OLLAMA_HOST = process.env.OLLAMA_TEST_HOST ?? 'http://localhost:11434';

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

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OLLAMA_ENV)('Release provider validation (Ollama)', () => {
  test('structured output remains schema-conformant for local model', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(OLLAMA_MODEL),
      structure: STRUCTURE,
      config: {
        baseUrl: OLLAMA_HOST,
      },
      params: {
        num_predict: 180,
      },
    });

    const turn = await model.generate('Classify release readiness as pass or fail. Return verdict and confidence.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
  }, 120000);

  test('tool loop executes add tool and returns expected sum', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(OLLAMA_MODEL),
      tools: [createAddTool()],
      config: {
        baseUrl: OLLAMA_HOST,
      },
      params: {
        num_predict: 220,
      },
    });

    const turn = await model.generate(
      'Call the add tool exactly once with a=14 and b=29. After the tool result, reply only with sum=43.',
    );

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 43 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('43');
  }, 120000);
});
