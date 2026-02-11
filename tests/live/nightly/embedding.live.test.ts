import { describe, expect, test } from 'bun:test';
import { embedding } from '../../../src/index.ts';
import { openai } from '../../../src/openai/index.ts';
import { google } from '../../../src/google/index.ts';
import type { OpenAIEmbedParams } from '../../../src/openai/index.ts';
import type { GoogleEmbedParams } from '../../../src/google/index.ts';
import { envModel } from '../../helpers/live.ts';

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const HAS_GOOGLE_KEY = Boolean(process.env.GOOGLE_API_KEY);

const OPENAI_MODEL = envModel('OPENAI_EMBED_TEST_MODEL', 'text-embedding-3-small');
const GOOGLE_MODEL = envModel('GOOGLE_EMBED_TEST_MODEL', 'gemini-embedding-001');

describe.skipIf(!HAS_OPENAI_KEY)('OpenAI embedding nightly', () => {
  test('single embedding returns vectors with dimensions', async () => {
    const model = embedding<OpenAIEmbedParams>({
      model: openai(OPENAI_MODEL),
    });

    const result = await model.embed('nightly embedding smoke check');

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]?.vector.length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 60000);
});

describe.skipIf(!HAS_GOOGLE_KEY)('Google embedding nightly', () => {
  test('batch embedding preserves order and vector payload', async () => {
    const model = embedding<GoogleEmbedParams>({
      model: google(GOOGLE_MODEL),
    });

    const result = await model.embed(['alpha', 'beta']);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]?.index).toBe(0);
    expect(result.embeddings[1]?.index).toBe(1);
    expect(result.embeddings[0]?.vector.length).toBeGreaterThan(0);
    expect(result.embeddings[1]?.vector.length).toBeGreaterThan(0);
  }, 60000);
});
