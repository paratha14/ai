import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  Image,
  embedding,
  image,
  llm,
} from '../../../src/index.ts';
import {
  parseBody,
  parseEmbeddingBody,
  parseImageBody,
  proxy,
  toEmbeddingJSON,
  toError,
  toImageJSON,
  toJSON,
} from '../../../src/proxy/index.ts';
import { AssistantMessage } from '../../../src/types/messages.ts';
import { createTurn, emptyUsage } from '../../../src/types/turn.ts';
import type {
  ProxyEmbeddingParams,
  ProxyImageParams,
  ProxyLLMParams,
} from '../../../src/proxy/index.ts';

const RUN_RELEASE_LIVE = process.env.RUN_RELEASE_LIVE === '1';
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGBgAAIAAQEAr6G0NwAAAABJRU5ErkJggg==';

interface LLMTransportCapture {
  model?: string;
  params?: Record<string, unknown>;
  messageCount: number;
}

interface EmbeddingTransportCapture {
  model?: string;
  params?: Record<string, unknown>;
  inputKinds: string[];
  imageMimeType?: string;
}

interface ImageTransportCapture {
  model?: string;
  params?: Record<string, unknown>;
  prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function hasMessagesArray(value: unknown): value is Record<string, unknown> & { messages: unknown[] } {
  return isRecord(value) && Array.isArray(value.messages);
}

function hasInputsArray(value: unknown): value is Record<string, unknown> & { inputs: unknown[] } {
  return isRecord(value) && Array.isArray(value.inputs);
}

function hasPromptField(value: unknown): value is Record<string, unknown> & { prompt: unknown } {
  return isRecord(value) && 'prompt' in value;
}

function isImageEmbeddingInput(input: unknown): input is { type: 'image'; source: unknown; mimeType: string } {
  return isRecord(input) && input.type === 'image' && typeof input.mimeType === 'string';
}

describe.skipIf(!RUN_RELEASE_LIVE)('Release proxy transport validation', () => {
  let server: ReturnType<typeof Bun.serve>;
  let endpoint = '';

  let llmCapture: LLMTransportCapture | undefined;
  let embeddingCapture: EmbeddingTransportCapture | undefined;
  let imageCapture: ImageTransportCapture | undefined;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        if (request.method !== 'POST') {
          return new Response('Not found', { status: 404 });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return toError('Invalid JSON', 400);
        }

        try {
          if (hasMessagesArray(body)) {
            const parsed = parseBody(body);
            llmCapture = {
              model: parsed.model,
              params: parsed.params,
              messageCount: parsed.messages.length,
            };

            const turn = createTurn(
              [...parsed.messages, new AssistantMessage('proxy release llm transport ok')],
              [],
              emptyUsage(),
              1,
            );

            return toJSON(turn);
          }

          if (hasInputsArray(body)) {
            const parsed = parseEmbeddingBody(body);
            const imageInput = parsed.inputs.find(isImageEmbeddingInput);

            embeddingCapture = {
              model: parsed.model,
              params: parsed.params,
              inputKinds: parsed.inputs.map((input) => (typeof input === 'string' ? 'string' : input.type)),
              imageMimeType: imageInput?.mimeType,
            };

            const vectors = parsed.inputs.map((input, index) => {
              const vector = typeof input === 'string'
                ? [input.length, index + 1]
                : [index + 2, 4];

              return {
                vector,
                dimensions: vector.length,
                index,
                tokens: index + 1,
                metadata: {
                  inputKind: typeof input === 'string' ? 'string' : input.type,
                },
              };
            });

            return toEmbeddingJSON({
              embeddings: vectors,
              usage: { totalTokens: vectors.length },
              metadata: { transport: 'proxy-release-embedding' },
            });
          }

          if (hasPromptField(body)) {
            const parsed = parseImageBody(body);
            imageCapture = {
              model: parsed.model,
              params: parsed.params,
              prompt: parsed.prompt,
            };

            return toImageJSON({
              images: [
                {
                  image: Image.fromBase64(TINY_PNG_BASE64, 'image/png'),
                  metadata: {
                    promptEcho: parsed.prompt,
                  },
                },
              ],
              metadata: { transport: 'proxy-release-image' },
              usage: { imagesGenerated: 1 },
            });
          }

          return toError('Unsupported proxy payload', 400);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return toError(message, 400);
        }
      },
    });

    endpoint = server.url.toString();
  });

  afterAll(() => {
    server.stop(true);
  });

  test('LLM transport forwards model and params through proxy', async () => {
    const model = llm<ProxyLLMParams>({
      model: proxy({ endpoint })('release-llm-model'),
      params: {
        temperature: 0,
        seed: 42,
      },
    });

    const turn = await model.generate('Return the release transport marker.');

    expect(turn.response.text).toContain('proxy release llm transport ok');
    expect(llmCapture).toBeDefined();
    expect(llmCapture?.model).toBe('release-llm-model');
    expect(llmCapture?.params).toEqual({
      temperature: 0,
      seed: 42,
    });
    expect(llmCapture?.messageCount).toBeGreaterThan(0);
  }, 30000);

  test('embedding transport relays text+image inputs and params', async () => {
    const model = embedding<ProxyEmbeddingParams>({
      model: proxy({ endpoint })('release-embedding-model'),
      params: {
        purpose: 'release-embedding-transport',
      },
    });

    const result = await model.embed([
      'alpha',
      {
        type: 'image',
        source: Image.fromBase64(TINY_PNG_BASE64, 'image/png'),
        mimeType: 'image/png',
      },
    ]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]?.dimensions).toBe(2);
    expect(result.embeddings[1]?.dimensions).toBe(2);
    expect(result.usage.totalTokens).toBe(2);
    expect(result.metadata?.transport).toBe('proxy-release-embedding');

    expect(embeddingCapture).toBeDefined();
    expect(embeddingCapture?.model).toBe('release-embedding-model');
    expect(embeddingCapture?.params).toEqual({
      purpose: 'release-embedding-transport',
    });
    expect(embeddingCapture?.inputKinds).toEqual(['string', 'image']);
    expect(embeddingCapture?.imageMimeType).toBe('image/png');
  }, 30000);

  test('image transport relays prompt and returns serialized image payload', async () => {
    const model = image<ProxyImageParams>({
      model: proxy({ endpoint })('release-image-model'),
      params: {
        quality: 'standard',
      },
    });

    const result = await model.generate('Generate one tiny pixel.');

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.image.toBase64()).toBe(TINY_PNG_BASE64);
    expect(result.usage?.imagesGenerated).toBe(1);
    expect(result.metadata?.transport).toBe('proxy-release-image');

    expect(imageCapture).toBeDefined();
    expect(imageCapture?.model).toBe('release-image-model');
    expect(imageCapture?.prompt).toBe('Generate one tiny pixel.');
    expect(imageCapture?.params).toEqual({
      quality: 'standard',
    });
  }, 30000);
});
