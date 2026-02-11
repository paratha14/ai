import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { anthropic } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { google } from '../../../src/google/index.ts';
import type { GoogleLLMParams } from '../../../src/google/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const OPENAI_REASONING_MODEL = envModel(
  'OPENAI_REASONING_TEST_MODEL',
  envModel('OPENAI_TEST_MODEL', 'gpt-5-mini'),
);
const ANTHROPIC_REASONING_MODEL = envModel(
  'ANTHROPIC_REASONING_TEST_MODEL',
  envModel('ANTHROPIC_TEST_MODEL', 'claude-haiku-4-5-20251001'),
);
const GOOGLE_REASONING_MODEL = envModel(
  'GOOGLE_REASONING_TEST_MODEL',
  envModel('GOOGLE_TEST_MODEL', 'gemini-3-flash-preview'),
);

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_OPENAI_REASONING_ACCESS = hasProviderAccess(
  process.env.OPENAI_API_KEY,
  OPENAI_REASONING_MODEL,
);
const HAS_ANTHROPIC_REASONING_ACCESS = hasProviderAccess(
  process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_REASONING_MODEL,
);
const HAS_GOOGLE_REASONING_ACCESS = hasProviderAccess(
  process.env.GOOGLE_API_KEY,
  GOOGLE_REASONING_MODEL,
);

const OPENAI_REASONING_MAX_ATTEMPTS = 5;
const ANTHROPIC_REASONING_MAX_ATTEMPTS = 3;

function combinedResponseOutput(response: { text: string; reasoning: Array<{ text: string }> }): string {
  return [response.text, ...response.reasoning.map((block) => block.text)]
    .join('\n')
    .trim();
}

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OPENAI_REASONING_ACCESS)('Release reasoning validation (OpenAI)', () => {
  test('returns deterministic arithmetic output', async () => {
    const model = llm<OpenAIResponsesParams>({
      model: openai(OPENAI_REASONING_MODEL),
      params: {
        reasoning: {
          effort: 'low',
          summary: 'detailed',
        },
        max_output_tokens: 400,
      },
    });

    const prompt = 'Compute 37 * 19. Return only the final integer.';
    let turn = await model.generate(prompt);
    for (
      let attempt = 1;
      attempt < OPENAI_REASONING_MAX_ATTEMPTS && !/\b703\b/.test(combinedResponseOutput(turn.response));
      attempt += 1
    ) {
      turn = await model.generate(prompt);
    }

    const combinedOutput = combinedResponseOutput(turn.response);
    expect(combinedOutput).toMatch(/\b703\b/);
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 120000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_ANTHROPIC_REASONING_ACCESS)('Release reasoning validation (Anthropic)', () => {
  test('returns deterministic arithmetic output', async () => {
    const model = llm<AnthropicLLMParams>({
      model: anthropic(ANTHROPIC_REASONING_MODEL),
      params: {
        max_tokens: 1200,
        thinking: {
          type: 'enabled',
          budget_tokens: 1024,
        },
      },
    });

    const prompt = 'Compute 37 * 19. Return only the final integer.';
    let turn = await model.generate(prompt);
    for (
      let attempt = 1;
      attempt < ANTHROPIC_REASONING_MAX_ATTEMPTS && !/\b703\b/.test(combinedResponseOutput(turn.response));
      attempt += 1
    ) {
      turn = await model.generate(prompt);
    }

    const combinedOutput = combinedResponseOutput(turn.response);
    expect(combinedOutput).toMatch(/\b703\b/);
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 120000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_GOOGLE_REASONING_ACCESS)('Release reasoning validation (Google)', () => {
  test('returns deterministic arithmetic output', async () => {
    const model = llm<GoogleLLMParams>({
      model: google(GOOGLE_REASONING_MODEL),
      params: {
        maxOutputTokens: 256,
        temperature: 0,
        thinkingConfig: {
          thinkingLevel: 'medium',
          includeThoughts: true,
        },
      },
    });

    const turn = await model.generate('Compute 37 * 19. Return only the final integer.');
    const combinedOutput = combinedResponseOutput(turn.response);
    expect(combinedOutput).toMatch(/\b703\b/);
    expect(combinedOutput.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 120000);
});
