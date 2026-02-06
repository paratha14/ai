/**
 * @fileoverview Unit tests for middleware failures during streaming and retry strategy coverage.
 *
 * Tests verify that when middleware's onStreamEvent throws a UPPError during streaming,
 * the error propagates through the stream iteration, gets caught by the retry loop,
 * and triggers retry behavior. Also covers all four retry strategies.
 */
import { test, expect, describe } from 'bun:test';
import { llm } from '../../../src/core/llm.ts';
import { createProvider } from '../../../src/core/provider.ts';
import { UPPError, ErrorCode, ModalityType } from '../../../src/types/errors.ts';
import type { LLMRequest, LLMResponse, LLMCapabilities } from '../../../src/types/llm.ts';
import type { LLMHandler } from '../../../src/types/provider.ts';
import type { TokenUsage } from '../../../src/types/turn.ts';
import { AssistantMessage } from '../../../src/types/messages.ts';
import type { StreamEvent } from '../../../src/types/stream.ts';
import { StreamEventType, textDelta } from '../../../src/types/stream.ts';
import type { LLMProvider } from '../../../src/types/provider.ts';
import type { Middleware, MiddlewareContext, StreamContext } from '../../../src/types/middleware.ts';
import {
  exponentialBackoff,
  linearBackoff,
  noRetry,
  retryAfterStrategy,
} from '../../../src/http/retry.ts';

type MockParams = { temperature?: number };

const defaultUsage = (inputTokens: number, outputTokens: number): TokenUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function createResponse(message: AssistantMessage, usage: TokenUsage): LLMResponse {
  return {
    message,
    usage,
    stopReason: 'stop',
  };
}

function createReliableStreamHandler(): LLMHandler<MockParams> {
  let providerRef: LLMProvider<MockParams> | null = null;

  const capabilities: LLMCapabilities = {
    streaming: true,
    tools: true,
    structuredOutput: true,
    imageInput: false,
    documentInput: false,
    videoInput: false,
    audioInput: false,
  };

  return {
    _setProvider(provider: LLMProvider<MockParams>) {
      providerRef = provider;
    },
    bind(modelId: string) {
      if (!providerRef) {
        throw new Error('Provider reference not set for mock handler');
      }

      return {
        modelId,
        capabilities,
        get provider() {
          return providerRef!;
        },
        async complete(request: LLMRequest<MockParams>): Promise<LLMResponse> {
          const message = new AssistantMessage('Success');
          return createResponse(message, defaultUsage(10, 20));
        },
        stream(request: LLMRequest<MockParams>) {
          const message = new AssistantMessage('Hello world');
          const response = createResponse(message, defaultUsage(10, 20));
          const events: StreamEvent[] = [
            textDelta('Hello '),
            textDelta('world'),
          ];

          return {
            async *[Symbol.asyncIterator]() {
              for (const event of events) {
                yield event;
              }
            },
            response: Promise.resolve(response),
          };
        },
      };
    },
  };
}

interface FlakyMiddlewareResult extends Middleware {
  reset(): void;
}

function createFlakyStreamMiddleware(failOnEventIndex: number): FlakyMiddlewareResult {
  let eventCount = 0;
  let hasFailed = false;
  return {
    name: 'flaky-middleware',
    onStreamEvent(event: StreamEvent, _ctx: StreamContext) {
      eventCount += 1;
      if (!hasFailed && eventCount === failOnEventIndex) {
        hasFailed = true;
        throw new UPPError(
          'Middleware failure',
          ErrorCode.ProviderError,
          'mock',
          ModalityType.LLM
        );
      }
      return event;
    },
    onRetry(_attempt: number, _error: Error, _ctx: MiddlewareContext) {
      eventCount = 0;
    },
    reset() {
      eventCount = 0;
      hasFailed = false;
    },
  };
}

describe('Stream Middleware Retry', () => {
  test('retries when middleware onStreamEvent throws UPPError', async () => {
    const handler = createReliableStreamHandler();
    const flakyMiddleware = createFlakyStreamMiddleware(2);

    const provider = createProvider({
      name: 'mock-mw',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [flakyMiddleware],
    });

    const stream = instance.stream('Hello');
    const events: StreamEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    const turn = await stream.turn;

    expect(turn.response.text).toBe('Hello world');
    expect(events.some((e) => e.type === StreamEventType.StreamRetry)).toBe(true);
  });

  test('middleware onRetry hook resets state for retry', async () => {
    const handler = createReliableStreamHandler();
    const flakyMiddleware = createFlakyStreamMiddleware(2);

    const provider = createProvider({
      name: 'mock-mw',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const retryAttempts: number[] = [];

    const retryTracker: Middleware = {
      name: 'retry-tracker',
      onRetry(attempt: number, _error: Error, _ctx: MiddlewareContext) {
        retryAttempts.push(attempt);
      },
    };

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [flakyMiddleware, retryTracker],
    });

    const stream = instance.stream('Hello');

    for await (const event of stream) {
      void event;
    }

    expect(retryAttempts.length).toBe(1);
    expect(retryAttempts[0]).toBe(1);
  });

  test('does not retry middleware errors with noRetry strategy', async () => {
    const handler = createReliableStreamHandler();
    const flakyMiddleware = createFlakyStreamMiddleware(1);

    const provider = createProvider({
      name: 'mock-mw',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: noRetry(),
      },
      middleware: [flakyMiddleware],
    });

    const stream = instance.stream('Hello');

    let errorThrown = false;
    try {
      for await (const event of stream) {
        void event;
      }
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).message).toContain('Middleware failure');
    }

    expect(errorThrown).toBe(true);
  });

  test('non-retryable middleware errors are not retried', async () => {
    const handler = createReliableStreamHandler();
    let eventCount = 0;

    const authFailMiddleware: Middleware = {
      name: 'auth-fail-middleware',
      onStreamEvent(event: StreamEvent, _ctx: StreamContext) {
        eventCount += 1;
        if (eventCount === 1) {
          throw new UPPError(
            'Auth failure in middleware',
            ErrorCode.AuthenticationFailed,
            'mock',
            ModalityType.LLM
          );
        }
        return event;
      },
    };

    const provider = createProvider({
      name: 'mock-mw',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [authFailMiddleware],
    });

    const stream = instance.stream('Hello');

    let caughtError: UPPError | null = null;
    try {
      for await (const event of stream) {
        void event;
      }
    } catch (error) {
      caughtError = error as UPPError;
    }

    expect(caughtError).toBeInstanceOf(UPPError);
    expect(caughtError!.code).toBe(ErrorCode.AuthenticationFailed);
  });
});

describe('Retry Strategy Coverage', () => {
  test('exponentialBackoff retries stream errors with backoff', async () => {
    const handler = createReliableStreamHandler();
    const flakyMiddleware = createFlakyStreamMiddleware(2);

    const provider = createProvider({
      name: 'mock-exp',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [flakyMiddleware],
    });

    const stream = instance.stream('Hello');
    let retryEvent: StreamEvent | null = null;

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvent = event;
      }
    }

    expect(retryEvent).not.toBeNull();
    expect(retryEvent!.delta.attempt).toBe(1);
    expect(retryEvent!.delta.maxAttempts).toBe(3);
  });

  test('linearBackoff retries stream errors with linear delay', async () => {
    const handler = createReliableStreamHandler();
    const flakyMiddleware = createFlakyStreamMiddleware(2);

    const provider = createProvider({
      name: 'mock-linear',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: linearBackoff({ maxAttempts: 3, delay: 10 }),
      },
      middleware: [flakyMiddleware],
    });

    const stream = instance.stream('Hello');
    let retryEvent: StreamEvent | null = null;

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvent = event;
      }
    }

    const turn = await stream.turn;

    expect(turn.response.text).toBe('Hello world');
    expect(retryEvent).not.toBeNull();
    expect(retryEvent!.delta.attempt).toBe(1);
    expect(retryEvent!.delta.maxAttempts).toBe(3);
  });

  test('retryAfterStrategy retries rate-limited errors', async () => {
    const handler = createReliableStreamHandler();
    let hasFailed = false;

    const rateLimitMiddleware: Middleware = {
      name: 'rate-limit-middleware',
      onStreamEvent(event: StreamEvent, _ctx: StreamContext) {
        if (!hasFailed) {
          hasFailed = true;
          throw new UPPError(
            'Rate limited',
            ErrorCode.RateLimited,
            'mock',
            ModalityType.LLM
          );
        }
        return event;
      },
    };

    const provider = createProvider({
      name: 'mock-retry-after',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 10 }),
      },
      middleware: [rateLimitMiddleware],
    });

    const stream = instance.stream('Hello');
    let retryEvent: StreamEvent | null = null;

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvent = event;
      }
    }

    const turn = await stream.turn;

    expect(turn.response.text).toBe('Hello world');
    expect(retryEvent).not.toBeNull();
    expect(retryEvent!.delta.attempt).toBe(1);
  });

  test('retryAfterStrategy does not retry non-rate-limited errors', async () => {
    const handler = createReliableStreamHandler();
    let eventCount = 0;

    const networkErrorMiddleware: Middleware = {
      name: 'network-error-middleware',
      onStreamEvent(event: StreamEvent, _ctx: StreamContext) {
        eventCount += 1;
        if (eventCount === 1) {
          throw new UPPError(
            'Network error',
            ErrorCode.NetworkError,
            'mock',
            ModalityType.LLM
          );
        }
        return event;
      },
    };

    const provider = createProvider({
      name: 'mock-retry-after',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 10 }),
      },
      middleware: [networkErrorMiddleware],
    });

    const stream = instance.stream('Hello');

    let errorThrown = false;
    try {
      for await (const event of stream) {
        void event;
      }
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).code).toBe(ErrorCode.NetworkError);
    }

    expect(errorThrown).toBe(true);
  });

  test('middleware error exhausts max attempts and throws', async () => {
    const handler = createReliableStreamHandler();

    const alwaysFailMiddleware: Middleware = {
      name: 'always-fail-middleware',
      onStreamEvent(event: StreamEvent, _ctx: StreamContext) {
        throw new UPPError(
          'Persistent failure',
          ErrorCode.ProviderError,
          'mock',
          ModalityType.LLM
        );
      },
    };

    const provider = createProvider({
      name: 'mock-exhaust',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 2, baseDelay: 10, jitter: false }),
      },
      middleware: [alwaysFailMiddleware],
    });

    const stream = instance.stream('Hello');

    await expect(async () => {
      for await (const event of stream) {
        void event;
      }
    }).toThrow(UPPError);
  });
});
