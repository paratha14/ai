import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { doFetch, doStreamFetch, warnInsecureUrl } from '../../../src/http/fetch.ts';
import type { RetryStrategy, RetryStrategyFactory } from '../../../src/types/provider.ts';
import { UPPError, ErrorCode } from '../../../src/types/errors.ts';

function createRetryAfterCapture(): { factory: RetryStrategyFactory; getSeconds: () => number | undefined } {
  let retryAfterSeconds: number | undefined;

  const factory: RetryStrategyFactory = () => ({
    setRetryAfter(seconds: number): void {
      retryAfterSeconds = seconds;
    },
    onRetry(_error: UPPError, _attempt: number): number | null {
      return null;
    },
  });

  return {
    factory,
    getSeconds: () => retryAfterSeconds,
  };
}

describe('doFetch', () => {
  test('retries once and runs beforeRequest per attempt', async () => {
    let callCount = 0;
    const fetchFn: typeof fetch = Object.assign(
      async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response('fail', { status: 500 });
        }
        return new Response('ok', { status: 200 });
      },
      { preconnect: (_input: string | URL) => undefined }
    );

    let beforeCount = 0;
    let retryCount = 0;

    const countingStrategy: RetryStrategyFactory = () => ({
      beforeRequest(): number {
        beforeCount += 1;
        return 0;
      },
      onRetry(_error: UPPError, attempt: number): number | null {
        retryCount += 1;
        return attempt < 2 ? 0 : null;
      },
    });

    const response = await doFetch(
      'https://example.com',
      { method: 'GET' },
      { fetch: fetchFn, retryStrategy: countingStrategy },
      'mock',
      'llm'
    );

    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
    expect(beforeCount).toBe(2);
    expect(retryCount).toBe(1);
  });

  test('does not retry when retryStrategy is omitted', async () => {
    let callCount = 0;
    const fetchFn: typeof fetch = Object.assign(
      async () => {
        callCount += 1;
        return new Response('fail', { status: 500 });
      },
      { preconnect: (_input: string | URL) => undefined }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn },
        'mock',
        'llm'
      )
    ).rejects.toBeInstanceOf(UPPError);

    expect(callCount).toBe(1);
  });

  test('parses Retry-After HTTP-date headers', async () => {
    const { factory, getSeconds } = createRetryAfterCapture();
    const httpDate = new Date(Date.now() + 1500).toUTCString();

    const fetchFn: typeof fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'Retry-After': httpDate },
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    try {
      await doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn, retryStrategy: factory },
        'mock',
        'llm'
      );
      throw new Error('Expected doFetch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UPPError);
    }

    const seconds = getSeconds();
    expect(seconds).toBeDefined();
    if (seconds !== undefined) {
      expect(seconds).toBeGreaterThanOrEqual(1);
    }
  });

  test('clamps Retry-After seconds to non-negative', async () => {
    const { factory, getSeconds } = createRetryAfterCapture();
    const fetchFn: typeof fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'Retry-After': '-5' },
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn, retryStrategy: factory },
        'mock',
        'llm'
      )
    ).rejects.toBeInstanceOf(UPPError);

    expect(getSeconds()).toBe(0);
  });

  test('clamps overly large Retry-After values', async () => {
    const { factory, getSeconds } = createRetryAfterCapture();
    const fetchFn: typeof fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'Retry-After': '999999' },
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn, retryStrategy: factory },
        'mock',
        'llm'
      )
    ).rejects.toBeInstanceOf(UPPError);

    const seconds = getSeconds();
    expect(seconds).toBeDefined();
    if (seconds !== undefined) {
      expect(seconds).toBeLessThan(999999);
    }
  });

  test('respects retryAfterMaxSeconds override', async () => {
    const { factory, getSeconds } = createRetryAfterCapture();
    const fetchFn: typeof fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: { 'Retry-After': '999' },
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn, retryStrategy: factory, retryAfterMaxSeconds: 5 },
        'mock',
        'llm'
      )
    ).rejects.toBeInstanceOf(UPPError);

    expect(getSeconds()).toBe(5);
  });

  test('times out when fetch does not resolve', async () => {
    const fetchFn: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const abortError = new Error('Aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            },
            { once: true }
          );
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn, timeout: 5 },
        'mock',
        'llm'
      )
    ).rejects.toMatchObject({ code: ErrorCode.Timeout });
  });

  test('throws CANCELLED when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET', signal: controller.signal },
        { timeout: 100 },
        'mock',
        'llm'
      )
    ).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });

  test('wraps network failures as NETWORK_ERROR', async () => {
    const fetchFn: typeof fetch = Object.assign(
      async () => {
        throw new Error('socket hang up');
      },
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn },
        'mock',
        'llm'
      )
    ).rejects.toMatchObject({ code: ErrorCode.NetworkError });
  });
});

describe('doStreamFetch', () => {
  test('returns response without checking status', async () => {
    const fetchFn: typeof fetch = Object.assign(
      async () =>
        new Response('not found', {
          status: 404,
        }),
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    const response = await doStreamFetch(
      'https://example.com',
      { method: 'GET' },
      { fetch: fetchFn },
      'mock',
      'llm'
    );

    expect(response.status).toBe(404);
  });

  test('wraps network failures as NETWORK_ERROR', async () => {
    const fetchFn: typeof fetch = Object.assign(
      async () => {
        throw new Error('dns failure');
      },
      {
        preconnect: (_input: string | URL) => undefined,
      }
    );

    await expect(
      doStreamFetch(
        'https://example.com',
        { method: 'GET' },
        { fetch: fetchFn },
        'mock',
        'llm'
      )
    ).rejects.toMatchObject({ code: ErrorCode.NetworkError });
  });
});

describe('warnInsecureUrl', () => {
  const originalEnv = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  test('warns for non-TLS URLs in non-production', () => {
    warnInsecureUrl('http://api.example.com', 'test');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('non-TLS URL');
  });

  test('does not warn for HTTPS URLs', () => {
    warnInsecureUrl('https://api.example.com', 'test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('does not warn for localhost', () => {
    warnInsecureUrl('http://localhost:8080', 'test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('does not warn for 127.0.0.1', () => {
    warnInsecureUrl('http://127.0.0.1:8080', 'test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('does not warn for IPv6 localhost [::1]', () => {
    warnInsecureUrl('http://[::1]:8080', 'test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('does not warn in production', () => {
    process.env.NODE_ENV = 'production';
    warnInsecureUrl('http://api.example.com', 'test');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('includes provider name in warning', () => {
    warnInsecureUrl('http://api.example.com', 'openai');
    expect(warnSpy.mock.calls[0]![0]).toContain('openai');
  });
});
