import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { responses } from '../../../src/responses/index.ts';
import type { ResponsesParams } from '../../../src/responses/index.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { createAddTool, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';

const HAS_OPENRESPONSES_KEY = Boolean(process.env.OPENRESPONSES_API_KEY);
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const RESPONSES_HOST = process.env.OPENRESPONSES_TEST_HOST ?? 'https://api.openai.com/v1';
const RESPONSES_MODEL = envModel(
  'OPENRESPONSES_RELEASE_TEST_MODEL',
  envModel('OPENRESPONSES_TEST_MODEL', envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini')),
);
const API_KEY_ENV = HAS_OPENRESPONSES_KEY ? 'OPENRESPONSES_API_KEY' : 'OPENAI_API_KEY';
const HAS_RESPONSES_ACCESS = (HAS_OPENRESPONSES_KEY || HAS_OPENAI_KEY) && RESPONSES_MODEL.length > 0;

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

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_RESPONSES_ACCESS)('Release provider validation (OpenResponses)', () => {
  test('structured output remains schema-conformant on configured host', async () => {
    const model = llm<ResponsesParams>({
      model: responses(RESPONSES_MODEL, {
        host: RESPONSES_HOST,
        apiKeyEnv: API_KEY_ENV,
      }),
      structure: STRUCTURE,
      params: {
        max_output_tokens: 180,
      },
    });

    const turn = await model.generate('Classify release readiness as pass or fail. Return verdict and confidence.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 90000);

  test('tool loop executes add tool and returns expected sum', async () => {
    const model = llm<ResponsesParams>({
      model: responses(RESPONSES_MODEL, {
        host: RESPONSES_HOST,
        apiKeyEnv: API_KEY_ENV,
      }),
      tools: [createAddTool()],
      params: {
        max_output_tokens: 220,
      },
    });

    const turn = await model.generate(
      'Call the add tool exactly once with a=14 and b=29. After the tool result, reply only with sum=43.',
    );

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 43 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('43');
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 90000);
});
