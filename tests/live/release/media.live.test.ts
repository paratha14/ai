import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Audio, Document, Image, Video, llm } from '../../../src/index.ts';
import { anthropic } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { google } from '../../../src/google/index.ts';
import type { GoogleLLMParams } from '../../../src/google/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { UserMessage } from '../../../src/types/messages.ts';
import { envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const ASSETS_DIR = resolve(process.cwd(), 'tests/assets');
const PDF_PATH = resolve(ASSETS_DIR, 'helloworld.pdf');
const IMAGE_PATH = resolve(ASSETS_DIR, 'duck.png');
const AUDIO_PATH = resolve(ASSETS_DIR, 'helloworld.mp3');
const VIDEO_PATH = resolve(ASSETS_DIR, 'BigBuckBunny_320x180.mp4');

const OPENAI_MEDIA_MODEL = envModel(
  'OPENAI_MEDIA_TEST_MODEL',
  envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini'),
);
const ANTHROPIC_MEDIA_MODEL = envModel(
  'ANTHROPIC_MEDIA_TEST_MODEL',
  envModel('ANTHROPIC_TEST_MODEL', 'claude-3-5-haiku-latest'),
);
const GOOGLE_MEDIA_MODEL = envModel(
  'GOOGLE_MEDIA_TEST_MODEL',
  envModel('GOOGLE_TEST_MODEL', 'gemini-2.0-flash'),
);

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_OPENAI_MEDIA_ACCESS = hasProviderAccess(
  process.env.OPENAI_API_KEY,
  OPENAI_MEDIA_MODEL,
);
const HAS_ANTHROPIC_MEDIA_ACCESS = hasProviderAccess(
  process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MEDIA_MODEL,
);
const HAS_GOOGLE_MEDIA_ACCESS = hasProviderAccess(
  process.env.GOOGLE_API_KEY,
  GOOGLE_MEDIA_MODEL,
);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OPENAI_MEDIA_ACCESS)('Release media validation (OpenAI)', () => {
  test('handles document and image input in one request', async () => {
    const [document, imageAsset] = await Promise.all([
      Document.fromPath(PDF_PATH),
      Image.fromPath(IMAGE_PATH),
    ]);

    const model = llm<OpenAIResponsesParams>({
      model: openai(OPENAI_MEDIA_MODEL),
      params: {
        max_output_tokens: 180,
      },
    });

    const turn = await model.generate(new UserMessage([
      {
        type: 'text',
        text: 'Confirm in one sentence that you received both a document and an image.',
      },
      document.toBlock(),
      imageAsset.toBlock(),
    ]));

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_ANTHROPIC_MEDIA_ACCESS)('Release media validation (Anthropic)', () => {
  test('handles document and image input in one request', async () => {
    const [document, imageAsset] = await Promise.all([
      Document.fromPath(PDF_PATH),
      Image.fromPath(IMAGE_PATH),
    ]);

    const model = llm<AnthropicLLMParams>({
      model: anthropic(ANTHROPIC_MEDIA_MODEL),
      params: {
        max_tokens: 180,
      },
    });

    const turn = await model.generate(new UserMessage([
      {
        type: 'text',
        text: 'Confirm in one sentence that you received both a document and an image.',
      },
      document.toBlock(),
      imageAsset.toBlock(),
    ]));

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_GOOGLE_MEDIA_ACCESS)('Release media validation (Google)', () => {
  test('handles document and image input in one request', async () => {
    const [document, imageAsset] = await Promise.all([
      Document.fromPath(PDF_PATH),
      Image.fromPath(IMAGE_PATH),
    ]);

    const model = llm<GoogleLLMParams>({
      model: google(GOOGLE_MEDIA_MODEL),
      params: {
        maxOutputTokens: 180,
      },
    });

    const turn = await model.generate(new UserMessage([
      {
        type: 'text',
        text: 'Confirm in one sentence that you received both a document and an image.',
      },
      document.toBlock(),
      imageAsset.toBlock(),
    ]));

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 180000);

  test('handles audio input', async () => {
    const audio = await Audio.fromPath(AUDIO_PATH);

    const model = llm<GoogleLLMParams>({
      model: google(GOOGLE_MEDIA_MODEL),
      params: {
        maxOutputTokens: 180,
      },
    });

    const turn = await model.generate(new UserMessage([
      {
        type: 'text',
        text: 'Briefly describe what is in this audio clip.',
      },
      audio.toBlock(),
    ]));

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 240000);

  test('handles video input', async () => {
    const video = await Video.fromPath(VIDEO_PATH);

    const model = llm<GoogleLLMParams>({
      model: google(GOOGLE_MEDIA_MODEL),
      params: {
        maxOutputTokens: 180,
      },
    });

    const turn = await model.generate(new UserMessage([
      {
        type: 'text',
        text: 'Briefly describe what is in this video clip.',
      },
      video.toBlock(),
    ]));

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.usage.totalTokens).toBeGreaterThan(0);
  }, 300000);
});
