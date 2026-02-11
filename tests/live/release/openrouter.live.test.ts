import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openrouter } from '../../../src/openrouter/index.ts';
import type {
  OpenRouterCompletionsParams,
  OpenRouterResponsesParams,
} from '../../../src/openrouter/index.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const OPENROUTER_MODEL = envModel(
  'OPENROUTER_RELEASE_TEST_MODEL',
  envModel('OPENROUTER_TEST_MODEL', 'openai/gpt-4o-mini'),
);
const HAS_OPENROUTER_ACCESS = Boolean(process.env.OPENROUTER_API_KEY) && OPENROUTER_MODEL.length > 0;

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

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OPENROUTER_ACCESS)('Release provider validation (OpenRouter)', () => {
  test('completions mode structured output stays schema-conformant', async () => {
    const model = llm<OpenRouterCompletionsParams>({
      model: openrouter(OPENROUTER_MODEL, { api: 'completions' }),
      structure: STRUCTURE,
      params: {
        max_tokens: 180,
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

  test('responses mode stream emits events and resolves final turn', async () => {
    const model = llm<OpenRouterResponsesParams>({
      model: openrouter(OPENROUTER_MODEL, { api: 'responses' }),
      params: {
        max_output_tokens: 120,
      },
    });

    const result = await collectTextStream(
      model.stream('Provide one short sentence about cross-provider release confidence.'),
    );

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
