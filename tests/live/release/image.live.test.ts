import { describe, expect, test } from 'bun:test';
import { image } from '../../../src/index.ts';
import { google } from '../../../src/google/index.ts';
import type { GoogleImagenParams } from '../../../src/google/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIImageParams } from '../../../src/openai/index.ts';
import { xai } from '../../../src/xai/index.ts';
import type { XAIImageParams } from '../../../src/providers/xai/image.ts';
import { envModel } from '../../helpers/live.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const OPENAI_IMAGE_MODEL = envModel('OPENAI_IMAGE_TEST_MODEL', 'gpt-image-1.5');
const GOOGLE_IMAGE_MODEL = envModel('GOOGLE_IMAGE_TEST_MODEL', 'imagen-4.0-ultra-generate-001');
const XAI_IMAGE_MODEL = envModel('XAI_IMAGE_TEST_MODEL', 'grok-imagine-image');

function hasProviderAccess(apiKey: string | undefined, model: string): boolean {
  return Boolean(apiKey) && model.length > 0;
}

const HAS_OPENAI_IMAGE_ACCESS = hasProviderAccess(
  process.env.OPENAI_API_KEY,
  OPENAI_IMAGE_MODEL,
);
const HAS_GOOGLE_IMAGE_ACCESS = hasProviderAccess(
  process.env.GOOGLE_API_KEY,
  GOOGLE_IMAGE_MODEL,
);
const HAS_XAI_IMAGE_ACCESS = hasProviderAccess(
  process.env.XAI_API_KEY,
  XAI_IMAGE_MODEL,
);

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_OPENAI_IMAGE_ACCESS)('Release image validation (OpenAI)', () => {
  test('OpenAI image generation returns at least one image payload', async () => {
    const model = image<OpenAIImageParams>({
      model: openai(OPENAI_IMAGE_MODEL),
    });

    const result = await model.generate('A minimal black-and-white icon of a lighthouse.');

    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.image).toBeDefined();
    expect(result.usage?.imagesGenerated ?? 0).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_GOOGLE_IMAGE_ACCESS)('Release image validation (Google)', () => {
  test('Google image generation returns at least one image payload', async () => {
    const model = image<GoogleImagenParams>({
      model: google(GOOGLE_IMAGE_MODEL),
      params: {
        sampleCount: 1,
        aspectRatio: '1:1',
      },
    });

    const result = await model.generate('A minimal black-and-white icon of a lighthouse.');

    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.image).toBeDefined();
    expect(result.usage?.imagesGenerated ?? 0).toBeGreaterThan(0);
  }, 180000);
});

describe.skipIf(!RUN_RELEASE_LIVE || !HAS_XAI_IMAGE_ACCESS)('Release image validation (xAI)', () => {
  test('xAI image generation returns at least one image payload', async () => {
    const model = image<XAIImageParams>({
      model: xai(XAI_IMAGE_MODEL),
      params: {
        n: 1,
        response_format: 'b64_json',
      },
    });

    const result = await model.generate('A minimal black-and-white icon of a lighthouse.');

    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0]?.image).toBeDefined();
    expect(result.usage?.imagesGenerated ?? 0).toBeGreaterThan(0);
  }, 120000);
});
