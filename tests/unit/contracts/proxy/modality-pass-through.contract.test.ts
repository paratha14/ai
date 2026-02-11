import { describe, expect, test } from 'bun:test';
import {
  Image,
  embedding,
  image,
} from '../../../../src/index.ts';
import { proxy } from '../../../../src/proxy/index.ts';
import type {
  ProxyEmbeddingParams,
  ProxyImageParams,
} from '../../../../src/proxy/index.ts';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGBgAAIAAQEAr6G0NwAAAABJRU5ErkJggg==';

interface SerializedBase64ImageSource {
  type: 'base64';
  data: string;
}

interface SerializedEmbeddingTextInput {
  type: 'text';
  text: string;
}

interface SerializedEmbeddingImageInput {
  type: 'image';
  mimeType: string;
  source: SerializedBase64ImageSource;
}

type SerializedEmbeddingInput =
  | string
  | SerializedEmbeddingTextInput
  | SerializedEmbeddingImageInput;

interface EmbeddingRequestPayload {
  model: string;
  inputs: SerializedEmbeddingInput[];
  params?: Record<string, unknown>;
}

interface ImageRequestPayload {
  model: string;
  prompt: string;
  params?: Record<string, unknown>;
}

function withBunFetchShape(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(handler, {
    preconnect: (_input: string | URL) => undefined,
  });
}

function parseBodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected proxy request body to be a JSON string');
  }

  return init.body;
}

describe('Proxy modality pass-through contracts', () => {
  test('embedding forwards params and serialized image inputs without mutation', async () => {
    let capturedPayload: EmbeddingRequestPayload | undefined;
    let capturedHeaders: Headers | undefined;

    const fetchFn = withBunFetchShape(async (_input, init) => {
      const payloadText = parseBodyText(init);
      capturedPayload = JSON.parse(payloadText) as EmbeddingRequestPayload;
      capturedHeaders = new Headers(init?.headers);

      return new Response(
        JSON.stringify({
          embeddings: [
            { vector: [0.1, 0.2], index: 0, tokens: 3 },
            { vector: [0.3, 0.4], index: 1, tokens: 5 },
          ],
          usage: { totalTokens: 8 },
          metadata: { source: 'proxy-unit-embedding' },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const instance = embedding<ProxyEmbeddingParams>({
      model: proxy({ endpoint: 'http://localhost:4100/proxy' })('embed-contract-model'),
      params: {
        purpose: 'proxy-unit-pass-through',
        topK: 4,
      },
      config: {
        fetch: fetchFn,
        headers: { 'x-proxy-contract': 'embedding' },
      },
    });

    const result = await instance.embed([
      { type: 'text', text: 'hello' },
      {
        type: 'image',
        source: Image.fromBase64(TINY_PNG_BASE64, 'image/png'),
        mimeType: 'image/png',
      },
    ]);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.model).toBe('embed-contract-model');
    expect(capturedPayload?.params).toEqual({
      purpose: 'proxy-unit-pass-through',
      topK: 4,
    });

    const input0 = capturedPayload?.inputs[0];
    const input1 = capturedPayload?.inputs[1];

    if (!input0 || typeof input0 === 'string' || input0.type !== 'text') {
      throw new Error('Expected first embedding input to be serialized text');
    }

    if (!input1 || typeof input1 === 'string' || input1.type !== 'image') {
      throw new Error('Expected second embedding input to be serialized image');
    }

    expect(input0.text).toBe('hello');
    expect(input1.mimeType).toBe('image/png');
    expect(input1.source.type).toBe('base64');
    expect(input1.source.data).toBe(TINY_PNG_BASE64);

    expect(capturedHeaders?.get('x-proxy-contract')).toBe('embedding');
    expect(capturedHeaders?.get('content-type')).toBe('application/json');
    expect(capturedHeaders?.get('accept')).toBe('application/json');

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]?.dimensions).toBe(2);
    expect(result.embeddings[1]?.tokens).toBe(5);
    expect(result.usage.totalTokens).toBe(8);
    expect(result.metadata?.source).toBe('proxy-unit-embedding');
  });

  test('image forwards prompt and params, then deserializes response image', async () => {
    let capturedPayload: ImageRequestPayload | undefined;
    let capturedHeaders: Headers | undefined;

    const fetchFn = withBunFetchShape(async (_input, init) => {
      const payloadText = parseBodyText(init);
      capturedPayload = JSON.parse(payloadText) as ImageRequestPayload;
      capturedHeaders = new Headers(init?.headers);

      return new Response(
        JSON.stringify({
          images: [
            {
              image: {
                source: {
                  type: 'base64',
                  data: TINY_PNG_BASE64,
                },
                mimeType: 'image/png',
                width: 1,
                height: 1,
              },
              metadata: {
                stage: 'unit',
              },
            },
          ],
          metadata: {
            source: 'proxy-unit-image',
          },
          usage: {
            imagesGenerated: 1,
          },
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const instance = image<ProxyImageParams>({
      model: proxy({ endpoint: 'http://localhost:4101/proxy' })('image-contract-model'),
      params: {
        quality: 'high',
      },
      config: {
        fetch: fetchFn,
        headers: { 'x-proxy-contract': 'image' },
      },
    });

    const result = await instance.generate({ prompt: 'Draw one tiny black pixel.' });

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.model).toBe('image-contract-model');
    expect(capturedPayload?.prompt).toBe('Draw one tiny black pixel.');
    expect(capturedPayload?.params).toEqual({
      quality: 'high',
    });

    expect(capturedHeaders?.get('x-proxy-contract')).toBe('image');
    expect(capturedHeaders?.get('content-type')).toBe('application/json');
    expect(capturedHeaders?.get('accept')).toBe('application/json');

    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.image.toBase64()).toBe(TINY_PNG_BASE64);
    expect(result.metadata?.source).toBe('proxy-unit-image');
    expect(result.usage?.imagesGenerated).toBe(1);
  });
});
