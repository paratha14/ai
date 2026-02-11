import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAICompletionsParams } from '../../../src/openai/index.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const MODEL = envModel('OPENAI_COMPLETIONS_TEST_MODEL', envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini'));

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

describe.skipIf(!HAS_OPENAI_KEY)('OpenAI completions live nightly', () => {
  test('structured output returns schema-conformant data in completions mode', async () => {
    const model = llm<OpenAICompletionsParams>({
      model: openai(MODEL, { api: 'completions' }),
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

  test('stream returns events and final turn in completions mode', async () => {
    const model = llm<OpenAICompletionsParams>({
      model: openai(MODEL, { api: 'completions' }),
      params: {
        max_tokens: 120,
      },
    });

    const result = await collectTextStream(
      model.stream('Provide one short sentence about compatibility checks in API integrations.')
    );

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
