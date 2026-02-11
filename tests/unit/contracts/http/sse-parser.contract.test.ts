import { describe, expect, test } from 'bun:test';
import { parseSSEStream, parseSimpleTextStream } from '../../../../src/http/sse.ts';
import { StreamEventType } from '../../../../src/types/stream.ts';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
  });
}

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of parseSSEStream(stream)) {
    events.push(event);
  }
  return events;
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of parseSimpleTextStream(stream)) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

describe('SSE parser contracts', () => {
  test('parses chunked events and stops on [DONE]', async () => {
    const events = await collectSSE(streamFromChunks([
      `event: ${StreamEventType.MessageStart}\n`,
      'data: {"type":"start"}\n\n',
      'data: {"delta":"hel',
      'lo"}\n\n',
      'data: [DONE]\n\n',
      'data: {"delta":"ignored"}\n\n',
    ]));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      _eventType: StreamEventType.MessageStart,
      type: 'start',
    });
    expect(events[1]).toEqual({ delta: 'hello' });
  });

  test('parses multiline data and ignores comment lines', async () => {
    const events = await collectSSE(streamFromChunks([
      ': keep-alive\n',
      'data: {"items":\n',
      'data: [1,2,3]}\n\n',
    ]));

    expect(events).toEqual([{ items: [1, 2, 3] }]);
  });

  test('skips malformed JSON blocks and preserves valid ones', async () => {
    const events = await collectSSE(streamFromChunks([
      'data: not-json\n\n',
      'data: {"ok":true}\n\n',
    ]));

    expect(events).toEqual([{ ok: true }]);
  });

  test('parseSimpleTextStream emits decoded text in order', async () => {
    const text = await collectText(streamFromChunks([
      'hello ',
      'from ',
      'stream',
    ]));

    expect(text).toBe('hello from stream');
  });
});
