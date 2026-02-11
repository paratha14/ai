import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { doFetch, doStreamFetch, warnInsecureUrl } from '../../../../src/http/fetch.ts';
import { ErrorCode, type UPPError } from '../../../../src/types/errors.ts';
import type { RetryStrategyFactory } from '../../../../src/types/provider.ts';

function createRetryAfterCapture(): {
  factory: RetryStrategyFactory;
  getSeconds: () => number | undefined;
} {
  let retryAfterSeconds: number | undefined;

  return {
    factory: () => ({
      setRetryAfter(seconds: number): void {
        retryAfterSeconds = seconds;
      },
      onRetry(_error: UPPError, _attempt: number): number | null {
        return null;
      },
    }),
    getSeconds: () => retryAfterSeconds,
  };
}

function withBunFetchShape(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(handler, {
    preconnect: (_input: string | URL) => undefined,
  });
}

describe('HTTP fetch contracts', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('retries once and executes beforeRequest once per attempt', async () => {
    let callCount = 0;
    let beforeRequestCount = 0;

    const fetchFn = withBunFetchShape(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response('fail', { status: 500 });
      }
      return new Response('ok', { status: 200 });
    });

    const retryStrategy: RetryStrategyFactory = () => ({
      beforeRequest(): number {
        beforeRequestCount += 1;
        return 0;
      },
      onRetry(_error, attempt): number | null {
        return attempt < 2 ? 0 : null;
      },
    });

    const response = await doFetch(
      'https://example.com',
      { method: 'GET' },
      { fetch: fetchFn, retryStrategy },
      'mock',
      'llm',
    );

    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
    expect(beforeRequestCount).toBe(2);
  });

  test('applies Retry-After header parsing and max clamp', async () => {
    const { factory, getSeconds } = createRetryAfterCapture();

    const fetchFn = withBunFetchShape(async () => (
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: {
          'Retry-After': '999',
        },
      })
    ));

    await expect(doFetch(
      'https://example.com',
      { method: 'GET' },
      {
        fetch: fetchFn,
        retryStrategy: factory,
        retryAfterMaxSeconds: 5,
      },
      'mock',
      'llm',
    )).rejects.toMatchObject({ code: ErrorCode.RateLimited });

    expect(getSeconds()).toBe(5);
  });

  test('normalizes timeout abort as TIMEOUT error', async () => {
    const fetchFn = withBunFetchShape(async (_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        }, { once: true });
      })
    ));

    await expect(doFetch(
      'https://example.com',
      { method: 'GET' },
      {
        fetch: fetchFn,
        timeout: 5,
      },
      'mock',
      'llm',
    )).rejects.toMatchObject({ code: ErrorCode.Timeout });
  });

  test('doStreamFetch returns non-OK response without normalization', async () => {
    const fetchFn = withBunFetchShape(async () => (
      new Response('stream error payload', {
        status: 502,
      })
    ));

    const response = await doStreamFetch(
      'https://example.com/stream',
      { method: 'POST' },
      { fetch: fetchFn },
      'mock',
      'llm',
    );

    expect(response.status).toBe(502);
  });

  test('warnInsecureUrl warns for non-local non-TLS URLs', () => {
    warnInsecureUrl('http://example.com', 'mock');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('non-TLS');
  });
});
