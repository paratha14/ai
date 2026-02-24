import { describe, expect, test } from 'bun:test';
import { streamSubscriber as streamExpressSubscriber } from '../../../../src/middleware/pubsub/server/express.ts';
import { streamSubscriber as streamFastifySubscriber } from '../../../../src/middleware/pubsub/server/fastify.ts';
import { runSubscriberStream } from '../../../../src/middleware/pubsub/server/shared.ts';
import type { PubSubAdapter } from '../../../../src/middleware/pubsub/types.ts';
import type { StreamEvent } from '../../../../src/types/stream.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createAdapter(options: { completeAfterMs?: number; finalData?: unknown } = {}): PubSubAdapter {
  const { completeAfterMs = 0, finalData } = options;

  return {
    async exists(): Promise<boolean> {
      return true;
    },
    async append(_streamId: string, _event: StreamEvent): Promise<void> {
      return Promise.resolve();
    },
    async getEvents(_streamId: string): Promise<StreamEvent[]> {
      return [];
    },
    subscribe(
      _streamId,
      _onEvent,
      onComplete,
      onFinalData
    ) {
      if (completeAfterMs <= 0) {
        if (finalData !== undefined) {
          onFinalData?.(finalData);
        }
        onComplete();
        return () => {};
      }

      const timer = setTimeout(() => {
        if (finalData !== undefined) {
          onFinalData?.(finalData);
        }
        onComplete();
      }, completeAfterMs);

      return () => {
        clearTimeout(timer);
      };
    },
    publish(_streamId: string, _event: StreamEvent): void {},
    setFinalData(_streamId: string, _data: unknown): void {},
    async remove(_streamId: string): Promise<void> {
      return Promise.resolve();
    },
    async clear(_streamId: string): Promise<void> {
      return Promise.resolve();
    },
    getCursorBase(_streamId: string): number {
      return 0;
    },
  };
}

function expectSSEHeaders(headers: Map<string, string>): void {
  expect(headers.get('Content-Type')).toBe('text/event-stream');
  expect(headers.get('Cache-Control')).toBe('no-cache');
  expect(headers.get('Connection')).toBe('keep-alive');
  expect(headers.get('X-Accel-Buffering')).toBe('no');
}

describe('Pubsub server contracts', () => {
  test('runSubscriberStream emits keepalive comments and clears timer on completion', async () => {
    const chunks: string[] = [];
    let ended = false;

    await runSubscriberStream(
      'stream-keepalive',
      createAdapter({ completeAfterMs: 30 }),
      {
        write: (data: string) => chunks.push(data),
        end: () => {
          ended = true;
        },
      },
      { keepaliveMs: 5 }
    );

    expect(ended).toBe(true);
    expect(chunks).toContain('data: [DONE]\n\n');
    expect(chunks.some((chunk) => chunk === ':keepalive\n\n')).toBe(true);

    const countAfterEnd = chunks.length;
    await delay(20);
    expect(chunks.length).toBe(countAfterEnd);
  });

  test('runSubscriberStream can disable keepalive comments', async () => {
    const chunks: string[] = [];

    await runSubscriberStream(
      'stream-no-keepalive',
      createAdapter({ completeAfterMs: 20 }),
      {
        write: (data: string) => chunks.push(data),
        end: () => {},
      },
      { keepaliveMs: 0 }
    );

    expect(chunks).toContain('data: [DONE]\n\n');
    expect(chunks.some((chunk) => chunk === ':keepalive\n\n')).toBe(false);
  });

  test('express adapter sets Cloudflare-safe SSE headers', async () => {
    const headers = new Map<string, string>();
    const chunks: string[] = [];
    let ended = false;

    await streamExpressSubscriber('stream-express', createAdapter(), {
      setHeader(name: string, value: string): void {
        headers.set(name, value);
      },
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
      end(): void {
        ended = true;
      },
      on(_event: 'close', _listener: () => void): void {},
    });

    expectSSEHeaders(headers);
    expect(ended).toBe(true);
    expect(chunks).toContain('data: [DONE]\n\n');
  });

  test('fastify adapter sets Cloudflare-safe SSE headers', async () => {
    const headers = new Map<string, string>();
    const chunks: string[] = [];
    let ended = false;

    await streamFastifySubscriber('stream-fastify', createAdapter(), {
      raw: {
        setHeader(name: string, value: string): void {
          headers.set(name, value);
        },
        write(chunk: string): boolean {
          chunks.push(chunk);
          return true;
        },
        end(): void {
          ended = true;
        },
        on(_event: 'close', _listener: () => void): void {},
      },
    });

    expectSSEHeaders(headers);
    expect(ended).toBe(true);
    expect(chunks).toContain('data: [DONE]\n\n');
  });
});
