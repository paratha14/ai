import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { anthropic, betas as anthropicBetas, tools as anthropicTools } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { google, tools as googleTools } from '../../../src/google/index.ts';
import type { GoogleLLMParams } from '../../../src/google/index.ts';
import { openai, tools as openaiTools } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { xai, tools as xaiTools } from '../../../src/xai/index.ts';
import type { XAIResponsesParams } from '../../../src/xai/index.ts';
import { envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';

const OPENAI_BUILTIN_TOOLS_MODEL = envModel(
  'OPENAI_BUILTIN_TOOLS_TEST_MODEL',
  envModel('OPENAI_TEST_MODEL', 'gpt-5.2'),
);
const ANTHROPIC_BUILTIN_TOOLS_MODEL = envModel(
  'ANTHROPIC_BUILTIN_TOOLS_TEST_MODEL',
  envModel('ANTHROPIC_TEST_MODEL', 'claude-sonnet-4-5'),
);
const GOOGLE_BUILTIN_TOOLS_MODEL = envModel(
  'GOOGLE_BUILTIN_TOOLS_TEST_MODEL',
  envModel('GOOGLE_TEST_MODEL', 'gemini-3-flash-preview'),
);
const XAI_BUILTIN_TOOLS_MODEL = envModel(
  'XAI_BUILTIN_TOOLS_TEST_MODEL',
  envModel('XAI_TEST_MODEL', 'grok-4-1-fast'),
);

type ResponsesToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; name: string };

interface OpenAIBuiltinToolParams extends OpenAIResponsesParams {
  tool_choice?: ResponsesToolChoice;
}

interface XAIBuiltinToolParams extends XAIResponsesParams {
  tool_choice?: ResponsesToolChoice;
}

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_OPENAI_TOOL_ACCESS = hasProviderAccess(
  process.env.OPENAI_API_KEY,
  OPENAI_BUILTIN_TOOLS_MODEL,
);
const HAS_ANTHROPIC_TOOL_ACCESS = hasProviderAccess(
  process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BUILTIN_TOOLS_MODEL,
);
const HAS_GOOGLE_TOOL_ACCESS = hasProviderAccess(
  process.env.GOOGLE_API_KEY,
  GOOGLE_BUILTIN_TOOLS_MODEL,
);
const HAS_XAI_TOOL_ACCESS = hasProviderAccess(
  process.env.XAI_API_KEY,
  XAI_BUILTIN_TOOLS_MODEL,
);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OPENAI_TOOL_ACCESS)('Release builtin tools validation (OpenAI)', () => {
  test('can use image generation built-in tool', async () => {
    const model = llm<OpenAIBuiltinToolParams>({
      model: openai(OPENAI_BUILTIN_TOOLS_MODEL),
      params: {
        max_output_tokens: 240,
        tool_choice: 'required',
        tools: [
          openaiTools.imageGeneration({
            size: '1024x1024',
          }),
        ],
      },
    });

    const turn = await model.generate('Use the image generation tool to create a simple monochrome lighthouse icon.');

    expect(turn.response.images.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 240000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_ANTHROPIC_TOOL_ACCESS)('Release builtin tools validation (Anthropic)', () => {
  test('can use code execution built-in tool', async () => {
    const model = llm<AnthropicLLMParams>({
      model: anthropic(ANTHROPIC_BUILTIN_TOOLS_MODEL, {
        betas: [anthropicBetas.codeExecution],
      }),
      params: {
        max_tokens: 320,
        tools: [anthropicTools.codeExecution()],
      },
    });

    const prompt = [
      'Use the code execution tool and run Python to print the SHA-256 hash of',
      '"anthropic-tool-check". Return a concise answer with the hash.',
    ].join(' ');
    const expectedHash = '4f8d6da835347b8c1985d7c2357c3b95df67ddb99843ca829234f0173566d364';

    let turn = await model.generate(prompt);
    for (let attempt = 1; attempt < 3 && !turn.response.text.includes(expectedHash); attempt += 1) {
      turn = await model.generate(prompt);
    }

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text).toContain(expectedHash);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 240000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_GOOGLE_TOOL_ACCESS)('Release builtin tools validation (Google)', () => {
  test('can use code execution built-in tool', async () => {
    const model = llm<GoogleLLMParams>({
      model: google(GOOGLE_BUILTIN_TOOLS_MODEL),
      params: {
        maxOutputTokens: 320,
        tools: [googleTools.codeExecution()],
      },
    });

    const turn = await model.generate(
      [
        'Use the code execution tool and run Python to print the SHA-256 hash of',
        '"google-tool-check". Return a concise answer with the hash.',
      ].join(' '),
    );

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text).toContain('fa024365ac6fab5bebcbe408461c4c2748a5ecfe3bd17d94eb5f3fed670bc820');
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 240000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_XAI_TOOL_ACCESS)('Release builtin tools validation (xAI)', () => {
  test('can use web search built-in tool', async () => {
    const model = llm<XAIBuiltinToolParams>({
      model: xai(XAI_BUILTIN_TOOLS_MODEL, { api: 'responses' }),
      params: {
        max_output_tokens: 260,
        tool_choice: 'required',
        tools: [xaiTools.webSearch()],
      },
    });

    const turn = await model.generate(
      'Use web search to find the official Bun runtime website and include at least one cited source.',
    );

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text).toMatch(/bun\.(sh|com)/i);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 240000);
});
