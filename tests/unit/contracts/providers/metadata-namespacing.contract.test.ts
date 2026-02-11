import { describe, expect, test } from 'bun:test';
import { createEmbeddingHandler as createGoogleEmbedHandler } from '../../../../src/providers/google/embed.ts';
import { createEmbeddingHandler as createOllamaEmbedHandler } from '../../../../src/providers/ollama/embed.ts';
import type { GoogleEmbedParams } from '../../../../src/providers/google/embed.ts';
import type { OllamaEmbedParams } from '../../../../src/providers/ollama/embed.ts';
import type { EmbeddingProvider } from '../../../../src/types/provider.ts';

function createMockProvider<TParams>(name: string): EmbeddingProvider<TParams> {
  return {
    name,
    version: '1.0.0',
  } as EmbeddingProvider<TParams>;
}

function createMockFetch(payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload))) as unknown as typeof fetch;
}

describe('Provider metadata contracts', () => {
  test('Google embedding metadata is namespaced under google', async () => {
    const handler = createGoogleEmbedHandler();
    handler._setProvider?.(createMockProvider<GoogleEmbedParams>('google'));

    const model = handler.bind('gemini-embedding-001');
    const response = await model.embed({
      inputs: ['hello'],
      config: {
        apiKey: 'test-key',
        fetch: createMockFetch({
          embeddings: [
            {
              values: [0.1, 0.2, 0.3],
              statistics: {
                tokenCount: 3,
                truncated: true,
              },
            },
          ],
        }),
      },
    });

    expect(response.embeddings).toHaveLength(1);
    expect(response.embeddings[0]?.metadata).toEqual({
      google: {
        truncated: true,
      },
    });
    expect(response.usage.totalTokens).toBe(3);
  });

  test('Ollama embedding response metadata is namespaced under ollama', async () => {
    const handler = createOllamaEmbedHandler();
    handler._setProvider?.(createMockProvider<OllamaEmbedParams>('ollama'));

    const model = handler.bind('nomic-embed-text');
    const response = await model.embed({
      inputs: ['hello'],
      config: {
        fetch: createMockFetch({
          model: 'nomic-embed-text',
          embeddings: [[0.5, 0.6, 0.7]],
          total_duration: 123,
          load_duration: 45,
          prompt_eval_count: 8,
        }),
      },
    });

    expect(response.embeddings).toHaveLength(1);
    expect(response.metadata).toEqual({
      ollama: {
        totalDuration: 123,
        loadDuration: 45,
      },
    });
    expect(response.usage.totalTokens).toBe(8);
  });

  test('metadata contracts do not emit un-namespaced top-level provider fields', async () => {
    const handler = createGoogleEmbedHandler();
    handler._setProvider?.(createMockProvider<GoogleEmbedParams>('google'));

    const model = handler.bind('gemini-embedding-001');
    const response = await model.embed({
      inputs: ['hello'],
      config: {
        apiKey: 'test-key',
        fetch: createMockFetch({
          embeddings: [
            {
              values: [0.1, 0.2, 0.3],
              statistics: {
                tokenCount: 2,
                truncated: false,
              },
            },
          ],
        }),
      },
    });

    const metadata = response.embeddings[0]?.metadata as Record<string, unknown> | undefined;
    expect(metadata).toBeDefined();
    expect(Object.keys(metadata ?? {})).toEqual(['google']);
  });
});
