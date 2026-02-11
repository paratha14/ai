import { describe, expect, test } from 'bun:test';
import {
  bindTools,
  parseBody,
  parseEmbeddingBody,
  parseImageBody,
  toSSE,
} from '../../../../src/providers/proxy/server/webapi.ts';
import { parseSSEStream } from '../../../../src/http/sse.ts';
import { AssistantMessage, UserMessage } from '../../../../src/types/messages.ts';
import { createStreamResult, textDelta } from '../../../../src/types/stream.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';
import type { StreamEvent } from '../../../../src/types/stream.ts';
import type { Tool } from '../../../../src/types/tool.ts';

async function collectSSEEvents(response: Response): Promise<unknown[]> {
  if (!response.body) {
    throw new Error('Expected SSE response to have a body stream');
  }

  const payloads: unknown[] = [];
  for await (const payload of parseSSEStream(response.body)) {
    payloads.push(payload);
  }

  return payloads;
}

describe('Proxy webapi contracts', () => {
  test('parseBody validates and deserializes request payloads', () => {
    const now = new Date().toISOString();

    const parsed = parseBody({
      messages: [
        {
          id: 'msg-1',
          type: 'user',
          timestamp: now,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
      system: 'You are concise.',
      params: { temperature: 0.1 },
      tools: [
        {
          name: 'ping',
          description: 'Returns pong',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      ],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.type).toBe('user');
    expect(parsed.messages[0]?.text).toBe('Hello');
    expect(parsed.system).toBe('You are concise.');
    expect(parsed.params).toEqual({ temperature: 0.1 });
    expect(parsed.tools?.[0]?.name).toBe('ping');
  });

  test('parseBody rejects malformed payloads', () => {
    expect(() => parseBody(null)).toThrow('Request body must be an object');
    expect(() => parseBody({})).toThrow('Request body must have a messages array');
  });

  test('parseEmbeddingBody and parseImageBody normalize transport shapes', () => {
    const embedding = parseEmbeddingBody({
      inputs: ['hello', { type: 'text', text: 'world' }],
      params: { batchSize: 2 },
      model: 'embed-model',
    });

    expect(embedding.inputs).toHaveLength(2);
    expect(embedding.params).toEqual({ batchSize: 2 });
    expect(embedding.model).toBe('embed-model');

    const image = parseImageBody({
      prompt: { prompt: 'draw a duck' },
      params: { quality: 'high' },
      model: 'image-model',
    });

    expect(image.prompt).toBe('draw a duck');
    expect(image.params).toEqual({ quality: 'high' });
    expect(image.model).toBe('image-model');
  });

  test('bindTools requires implementations for all declared schemas', async () => {
    const schemas: Array<Pick<Tool, 'name' | 'description' | 'parameters'>> = [
      {
        name: 'sum',
        description: 'Adds two numbers.',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
    ];

    const tools = bindTools(schemas, {
      sum: async (params: unknown) => {
        const casted = params as { a: number; b: number };
        return { value: casted.a + casted.b };
      },
    });

    expect(tools).toHaveLength(1);
    await expect(tools[0]?.run({ a: 2, b: 3 })).resolves.toEqual({ value: 5 });

    expect(() => bindTools(schemas, {})).toThrow('No implementation for tool: sum');
  });

  test('toSSE streams events then emits final serialized turn', async () => {
    async function* streamGenerator(): AsyncGenerator<StreamEvent, void, unknown> {
      yield textDelta('hello');
    }

    const finalTurn = createTurn(
      [
        new UserMessage('Hi'),
        new AssistantMessage('hello'),
      ],
      [],
      emptyUsage(),
      1,
    );

    const stream = createStreamResult(
      streamGenerator(),
      Promise.resolve(finalTurn),
      new AbortController(),
    );

    const response = toSSE(stream);
    const payloads = await collectSSEEvents(response);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(payloads.length).toBe(2);

    const first = payloads[0] as { type?: string; delta?: { text?: string } };
    const second = payloads[1] as { messages?: Array<{ type: string }> };

    expect(first.type).toBe('text_delta');
    expect(first.delta?.text).toBe('hello');
    expect(second.messages?.[0]?.type).toBe('user');
    expect(second.messages?.[1]?.type).toBe('assistant');
  });
});
