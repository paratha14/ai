/**
 * @fileoverview Unit tests for streaming retry functionality in the LLM core module.
 *
 * Tests cover retry behavior for streaming requests including:
 * - Successful retry after transient errors
 * - Retry event emission
 * - Middleware onRetry hooks
 * - State reset between retries
 * - Max attempts exhaustion
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
import type { Middleware, MiddlewareContext } from '../../../src/types/middleware.ts';
import { exponentialBackoff, noRetry } from '../../../src/http/retry.ts';

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

interface MockStreamOptions {
  failCount?: number;
  errorCode?: ErrorCode;
  onRequest?: (request: LLMRequest<MockParams>) => void;
  capabilities?: Partial<LLMCapabilities>;
}

function createRetryingMockLLMHandler(options: MockStreamOptions = {}): LLMHandler<MockParams> {
  let providerRef: LLMProvider<MockParams> | null = null;
  let requestCount = 0;
  const failCount = options.failCount ?? 1;
  const errorCode = options.errorCode ?? ErrorCode.NetworkError;

  const capabilities: LLMCapabilities = {
    streaming: true,
    tools: true,
    structuredOutput: true,
    imageInput: false,
    documentInput: false,
    videoInput: false,
    audioInput: false,
    ...options.capabilities,
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
          options.onRequest?.(request);
          requestCount += 1;
          if (requestCount <= failCount) {
            throw new UPPError(
              'Network error',
              errorCode,
              'mock',
              ModalityType.LLM
            );
          }
          const message = new AssistantMessage('Success after retry');
          return createResponse(message, defaultUsage(10, 20));
        },
        stream(request: LLMRequest<MockParams>) {
          options.onRequest?.(request);
          requestCount += 1;

          if (requestCount <= failCount) {
            const streamError = new UPPError(
              'Network error during streaming',
              errorCode,
              'mock',
              ModalityType.LLM
            );

            return {
              async *[Symbol.asyncIterator]() {
                yield textDelta('Starting...');
                throw streamError;
              },
              response: new Promise<LLMResponse>(() => {
                // Never resolves - stream error takes precedence
              }),
            };
          }

          const message = new AssistantMessage('Success after retry');
          const response = createResponse(message, defaultUsage(10, 20));
          const events: StreamEvent[] = [
            textDelta('Success '),
            textDelta('after '),
            textDelta('retry'),
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

describe('Streaming Retry', () => {
  test('retries streaming request on network error', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');
    const events: StreamEvent[] = [];

    for await (const event of stream) {
      events.push(event);
    }

    const turn = await stream.turn;

    expect(turn.response.text).toBe('Success after retry');
    expect(events.some((e) => e.type === StreamEventType.StreamRetry)).toBe(true);
  });

  test('emits stream_retry event with correct attempt number', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 2 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');
    const retryEvents: StreamEvent[] = [];

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvents.push(event);
      }
    }

    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0]!.delta.attempt).toBe(1);
    expect(retryEvents[1]!.delta.attempt).toBe(2);
  });

  test('calls middleware onRetry hook on each retry', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const retryHookCalls: { attempt: number; error: Error }[] = [];

    const middleware: Middleware = {
      name: 'retry-tracker',
      onRetry(attempt: number, error: Error, _ctx: MiddlewareContext) {
        retryHookCalls.push({ attempt, error });
      },
    };

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
      middleware: [middleware],
    });

    const stream = instance.stream('Hello');

    for await (const event of stream) {
      void event;
      // Consume stream
    }

    expect(retryHookCalls.length).toBe(1);
    expect(retryHookCalls[0]!.attempt).toBe(1);
    expect(retryHookCalls[0]!.error.message).toContain('Network error');
  });

  test('throws when max retry attempts exceeded', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 5 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 2, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');

    await expect(async () => {
      for await (const event of stream) {
      void event;
        // Consume stream
      }
    }).toThrow(UPPError);
  });

  test('does not retry non-retryable errors', async () => {
    const handler = createRetryingMockLLMHandler({
      failCount: 1,
      errorCode: ErrorCode.AuthenticationFailed,
    });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');

    let errorThrown = false;
    try {
      for await (const event of stream) {
      void event;
        // Consume stream
      }
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(UPPError);
      expect((error as UPPError).code).toBe(ErrorCode.AuthenticationFailed);
    }

    expect(errorThrown).toBe(true);
  });

  test('does not retry with noRetry strategy', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: noRetry(),
      },
    });

    const stream = instance.stream('Hello');

    let errorThrown = false;
    try {
      for await (const event of stream) {
      void event;
        // Consume stream
      }
    } catch (error) {
      errorThrown = true;
      expect(error).toBeInstanceOf(UPPError);
    }

    expect(errorThrown).toBe(true);
  });

  test('resets messages on retry', async () => {
    const requestMessages: number[] = [];

    const handler = createRetryingMockLLMHandler({
      failCount: 1,
      onRequest: (request) => {
        requestMessages.push(request.messages.length);
      },
    });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');

    for await (const event of stream) {
      void event;
      // Consume stream
    }

    // Both requests should have the same number of messages (reset on retry)
    expect(requestMessages.length).toBe(2);
    expect(requestMessages[0]).toBe(requestMessages[1]);
  });

  test('stream_retry event includes maxAttempts from strategy', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 5, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');
    let retryEvent: StreamEvent | null = null;

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvent = event;
      }
    }

    expect(retryEvent).not.toBeNull();
    expect(retryEvent!.delta.maxAttempts).toBe(5);
  });

  test('includes error in stream_retry event', async () => {
    const handler = createRetryingMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-retry',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    const stream = instance.stream('Hello');
    let retryEvent: StreamEvent | null = null;

    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvent = event;
      }
    }

    expect(retryEvent).not.toBeNull();
    // Error is serialized for JSON transport
    expect(retryEvent!.delta.error).toBeDefined();
    expect(retryEvent!.delta.error!.message).toContain('Network error');
  });
});
