import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import { createAddTool, envModel } from '../../helpers/live.ts';

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const MODEL = envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini');
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

  expect(uppError.provider).toBe('openai');
  const validCode = uppError.code === ErrorCode.InvalidRequest
    || uppError.code === ErrorCode.ModelNotFound
    || uppError.code === ErrorCode.ProviderError;
  expect(validCode).toBe(true);
}

describe.skipIf(!HAS_OPENAI_KEY)('OpenAI live nightly', () => {
  test('structured output returns schema-conformant data', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      structure: STRUCTURE,
      params: {
        max_output_tokens: 180,
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
    const model = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      tools: [createAddTool()],
      params: {
        max_output_tokens: 220,
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

  test('previous_response_id chaining preserves response_id across turns', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        max_output_tokens: 100,
        store: true,
      },
    });

    const firstTurn = await model.generate('Say exactly: "ALPHA"');

    const firstMeta = firstTurn.response.metadata?.openai as
      | { response_id?: string }
      | undefined;
    expect(firstMeta?.response_id).toBeDefined();
    expect(typeof firstMeta?.response_id).toBe('string');

    const continuationModel = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        max_output_tokens: 100,
        previous_response_id: firstMeta?.response_id,
      },
    });

    const secondTurn = await continuationModel.generate('What was the exact word I asked you to say?');

    const secondMeta = secondTurn.response.metadata?.openai as
      | { response_id?: string }
      | undefined;
    expect(secondMeta?.response_id).toBeDefined();
    expect(secondMeta?.response_id).not.toBe(firstMeta?.response_id);
    expect(secondTurn.response.text.toLowerCase()).toContain('alpha');
  }, 90000);

  test('context_management compaction emits compaction items with low threshold', async () => {
    const compactionParams: Partial<OpenAIResponsesParams> = {
      max_output_tokens: 500,
      store: true,
      context_management: [{ type: 'compaction', compact_threshold: 1000 }],
    };

    type OpenAIMeta = { response_id?: string; compactionItems?: Array<{ id: string; data: string }> };

    const firstModel = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: compactionParams as OpenAIResponsesParams,
    });

    const firstTurn = await firstModel.generate(
      'Write a detailed paragraph about the history of computing, from Babbage to modern GPUs. Include dates, names, and technical details.'
    );
    const firstMeta = firstTurn.response.metadata?.openai as OpenAIMeta | undefined;
    expect(firstMeta?.response_id).toBeDefined();

    const secondModel = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        ...compactionParams,
        previous_response_id: firstMeta?.response_id,
      } as OpenAIResponsesParams,
    });

    const secondTurn = await secondModel.generate(
      'Now write an equally detailed paragraph about the history of artificial intelligence, from Turing to transformers. Include dates, names, and technical details.'
    );
    const secondMeta = secondTurn.response.metadata?.openai as OpenAIMeta | undefined;
    expect(secondMeta?.response_id).toBeDefined();

    const thirdModel = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        ...compactionParams,
        previous_response_id: secondMeta?.response_id,
      } as OpenAIResponsesParams,
    });

    const thirdTurn = await thirdModel.generate(
      'Write another detailed paragraph about the history of the internet, from ARPANET to modern cloud computing. Include dates and technical milestones.'
    );
    const thirdMeta = thirdTurn.response.metadata?.openai as OpenAIMeta | undefined;
    expect(thirdMeta?.response_id).toBeDefined();

    const fourthModel = llm<OpenAIResponsesParams>({
      model: openai(MODEL),
      params: {
        ...compactionParams,
        previous_response_id: thirdMeta?.response_id,
      } as OpenAIResponsesParams,
    });

    const fourthTurn = await fourthModel.generate(
      'Summarize everything we discussed about computing, AI, and the internet into key themes.'
    );
    const fourthMeta = fourthTurn.response.metadata?.openai as OpenAIMeta | undefined;
    expect(fourthMeta?.response_id).toBeDefined();

    // With a 1000-token threshold across 4 verbose turns, at least one should trigger compaction
    const allCompactionItems = [
      ...(firstMeta?.compactionItems ?? []),
      ...(secondMeta?.compactionItems ?? []),
      ...(thirdMeta?.compactionItems ?? []),
      ...(fourthMeta?.compactionItems ?? []),
    ];
    expect(allCompactionItems.length).toBeGreaterThan(0);

    const item = allCompactionItems[0]!;
    expect(typeof item.id).toBe('string');
    expect(item.id.startsWith('cmp_')).toBe(true);
  }, 180000);

  test('invalid model returns normalized error', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(INVALID_MODEL),
      params: {
        max_output_tokens: 24,
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
