import { describe, expect, test } from 'bun:test';
import { doFetch } from '../../../src/http/fetch.ts';
import { exponentialBackoff, linearBackoff, noRetry, retryAfterStrategy } from '../../../src/http/retry.ts';
import { UPPError, ErrorCode, ModalityType } from '../../../src/types/errors.ts';
import type { ProviderConfig } from '../../../src/types/provider.ts';

function mockFetchFn(handler: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return Object.assign(handler, {
    preconnect: (_input: string | URL) => undefined,
  });
}

describe('doFetch Retry - Embedding Modality', () => {
  test('retries on 503 and succeeds', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
      }
      return new Response(JSON.stringify({ result: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
    };

    const response = await doFetch('https://api.example.com/embed', { method: 'POST' }, config, 'test-provider', ModalityType.Embedding);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('retries on 429 with retryAfterStrategy', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('Too Many Requests', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response(JSON.stringify({ embeddings: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 10 }),
    };

    const response = await doFetch('https://api.example.com/embed', { method: 'POST' }, config, 'test-provider', ModalityType.Embedding);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('retries on network error and succeeds', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 1) {
        throw new Error('fetch failed');
      }
      return new Response(JSON.stringify({ embeddings: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
    };

    const response = await doFetch('https://api.example.com/embed', { method: 'POST' }, config, 'test-provider', ModalityType.Embedding);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('does not retry 401 (AuthenticationFailed)', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401,
        statusText: 'Unauthorized',
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
    };

    try {
      await doFetch('https://api.example.com/embed', { method: 'POST' }, config, 'test-provider', ModalityType.Embedding);
      throw new Error('Expected doFetch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).code).toBe(ErrorCode.AuthenticationFailed);
    }

    expect(callCount).toBe(1);
  });

  test('exhausts max attempts then throws UPPError', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: exponentialBackoff({ maxAttempts: 2, baseDelay: 10, jitter: false }),
    };

    try {
      await doFetch('https://api.example.com/embed', { method: 'POST' }, config, 'test-provider', ModalityType.Embedding);
      throw new Error('Expected doFetch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).code).toBe(ErrorCode.ProviderError);
      expect((error as UPPError).modality).toBe(ModalityType.Embedding);
    }

    expect(callCount).toBe(3);
  });
});

describe('doFetch Retry - Image Modality', () => {
  test('retries on 503 and succeeds', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 1) {
        return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
      }
      return new Response(JSON.stringify({ url: 'https://img.example.com/1.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: linearBackoff({ maxAttempts: 3, delay: 10 }),
    };

    const response = await doFetch('https://api.example.com/image', { method: 'POST' }, config, 'test-provider', ModalityType.Image);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('retries on network error and succeeds', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 1) {
        throw new Error('ECONNREFUSED');
      }
      return new Response(JSON.stringify({ url: 'https://img.example.com/1.png' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
    };

    const response = await doFetch('https://api.example.com/image', { method: 'POST' }, config, 'test-provider', ModalityType.Image);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('noRetry fails immediately', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: noRetry(),
    };

    try {
      await doFetch('https://api.example.com/image', { method: 'POST' }, config, 'test-provider', ModalityType.Image);
      throw new Error('Expected doFetch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).code).toBe(ErrorCode.ProviderError);
    }

    expect(callCount).toBe(1);
  });

  test('error includes correct modality in UPPError', async () => {
    const fetchFn = mockFetchFn(async () => new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: noRetry(),
    };

    try {
      await doFetch('https://api.example.com/image', { method: 'POST' }, config, 'test-provider', ModalityType.Image);
      throw new Error('Expected doFetch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).modality).toBe('image');
      expect((error as UPPError).provider).toBe('test-provider');
    }
  });
});

describe('doFetch Retry - LLM Modality', () => {
  test('retries on 500/502/503/504 server errors', async () => {
    const serverErrors = [500, 502, 503, 504];

    for (const statusCode of serverErrors) {
      let callCount = 0;
      const fetchFn = mockFetchFn(async () => {
        callCount++;
        if (callCount <= 1) {
          return new Response('Server Error', { status: statusCode, statusText: 'Server Error' });
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const config: ProviderConfig = {
        fetch: fetchFn,
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      };

      const response = await doFetch('https://api.example.com/chat', { method: 'POST' }, config, 'test-provider', ModalityType.LLM);
      expect(response.ok).toBe(true);
      expect(callCount).toBe(2);
    }
  });

  test('retries on 429 with Retry-After header', async () => {
    let callCount = 0;
    const fetchFn = mockFetchFn(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response('Too Many Requests', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '1' },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 10 }),
    };

    const response = await doFetch('https://api.example.com/chat', { method: 'POST' }, config, 'test-provider', ModalityType.LLM);
    expect(response.ok).toBe(true);
    expect(callCount).toBe(3);
  });

  test('strategy factory creates fresh instance per request', async () => {
    let factoryCallCount = 0;
    const factory = (): ReturnType<typeof exponentialBackoff> => {
      const inner = exponentialBackoff({ maxAttempts: 2, baseDelay: 10, jitter: false });
      return () => {
        factoryCallCount++;
        return inner();
      };
    };

    const wrappedFactory = factory();

    let fetchCallCount = 0;
    const fetchFn = mockFetchFn(async () => {
      fetchCallCount++;
      return new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
    });

    const config: ProviderConfig = {
      fetch: fetchFn,
      retryStrategy: wrappedFactory,
    };

    const doFetchAttempt = async () => {
      try {
        await doFetch('https://api.example.com/chat', { method: 'POST' }, config, 'test-provider', ModalityType.LLM);
      } catch (error) {
        expect(error).toBeInstanceOf(UPPError);
      }
    };

    await doFetchAttempt();
    const firstFetchCount = fetchCallCount;
    await doFetchAttempt();

    expect(factoryCallCount).toBe(2);
    expect(fetchCallCount).toBe(firstFetchCount * 2);
  });
});
