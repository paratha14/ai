import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { google } from '../../../src/google/index.ts';
import type { GoogleLLMParams } from '../../../src/google/index.ts';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? '';
const GOOGLE_CACHE_MODEL = process.env.GOOGLE_CACHE_TEST_MODEL ?? process.env.GOOGLE_TEST_MODEL ?? '';
const RUN_GOOGLE_CACHE_LIVE = process.env.RUN_GOOGLE_CACHE_LIVE === '1';

const SHOULD_SKIP = GOOGLE_API_KEY.length === 0
  || GOOGLE_CACHE_MODEL.length === 0
  || !RUN_GOOGLE_CACHE_LIVE;

const CACHE_CONTEXT = Array.from(
  { length: 100 },
  (_, index) => `Reference clause ${index + 1}: cache validation context for nightly coverage.`,
).join(' ');

describe.skipIf(SHOULD_SKIP)('Google cache live nightly', () => {
  test('cache API creates reusable context and reports cache token reads', async () => {
    const displayName = `pp-nightly-cache-${Date.now()}`;
    const created = await google.cache.create({
      apiKey: GOOGLE_API_KEY,
      model: GOOGLE_CACHE_MODEL,
      displayName,
      ttl: '3600s',
      contents: [
        {
          role: 'user',
          parts: [{ text: CACHE_CONTEXT }],
        },
      ],
    });

    try {
      expect(created.name.startsWith('cachedContents/')).toBe(true);

      const fetched = await google.cache.get(created.name, GOOGLE_API_KEY);
      expect(fetched.name).toBe(created.name);

      const model = llm<GoogleLLMParams>({
        model: google(GOOGLE_CACHE_MODEL),
        params: {
          temperature: 0,
          maxOutputTokens: 80,
          cachedContent: created.name,
        },
      });

      const turn = await model.generate('Reply with CACHE_OK and one short sentence.');

      expect(turn.response.text).toContain('CACHE_OK');
      expect(turn.usage.cacheReadTokens).toBeGreaterThan(0);
    } finally {
      await google.cache.delete(created.name, GOOGLE_API_KEY);
    }
  }, 120000);
});
