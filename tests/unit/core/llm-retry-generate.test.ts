/**
 * @fileoverview Unit tests for generate (non-streaming) retry behavior in the LLM core module.
 *
 * Tests verify that executeGenerate does NOT retry on failure since it has no retry loop.
 * Instead, errors propagate after running the onError middleware hook.
 */
import { test, expect, describe } from 'bun:test';
import { llm } from '../../../src/core/llm.ts';
import { createProvider } from '../../../src/core/provider.ts';
import { UPPError, ErrorCode, ModalityType } from '../../../src/types/errors.ts';
import type { LLMRequest, LLMResponse, LLMCapabilities } from '../../../src/types/llm.ts';
import type { LLMHandler } from '../../../src/types/provider.ts';
import type { TokenUsage } from '../../../src/types/turn.ts';
import { AssistantMessage } from '../../../src/types/messages.ts';
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

interface MockGenerateOptions {
  failCount?: number;
  errorCode?: ErrorCode;
  capabilities?: Partial<LLMCapabilities>;
}

function createMockLLMHandler(options: MockGenerateOptions = {}): LLMHandler<MockParams> {
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
          requestCount += 1;
          if (requestCount <= failCount) {
            throw new UPPError(
              'Network error',
              errorCode,
              'mock',
              ModalityType.LLM
            );
          }
          const message = new AssistantMessage('Success');
          return createResponse(message, defaultUsage(10, 20));
        },
        stream() {
          throw new Error('stream not implemented in generate tests');
        },
      };
    },
  };
}

describe('Generate Retry Behavior', () => {
  test('generate throws on first failure without retrying', async () => {
    const handler = createMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    await expect(instance.generate('Hello')).rejects.toThrow(UPPError);
  });

  test('onRetry middleware hook is not called for generate', async () => {
    const handler = createMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-gen',
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

    try {
      await instance.generate('Hello');
    } catch {
      // Expected to throw
    }

    expect(retryHookCalls.length).toBe(0);
  });

  test('onError middleware hook is called on generate failure', async () => {
    const handler = createMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const errorHookCalls: { error: Error }[] = [];

    const middleware: Middleware = {
      name: 'error-tracker',
      onError(error: Error, _ctx: MiddlewareContext) {
        errorHookCalls.push({ error });
      },
    };

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
      middleware: [middleware],
    });

    try {
      await instance.generate('Hello');
    } catch {
      // Expected to throw
    }

    expect(errorHookCalls.length).toBe(1);
    expect(errorHookCalls[0]!.error).toBeInstanceOf(UPPError);
    expect(errorHookCalls[0]!.error.message).toContain('Network error');
  });

  test('retry strategy does not affect generate behavior', async () => {
    const handler = createMockLLMHandler({ failCount: 1 });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: noRetry(),
      },
    });

    await expect(instance.generate('Hello')).rejects.toThrow(UPPError);
  });

  test('non-retryable errors propagate correctly from generate', async () => {
    const handler = createMockLLMHandler({
      failCount: 1,
      errorCode: ErrorCode.AuthenticationFailed,
    });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
    });

    let caughtError: UPPError | null = null;
    try {
      await instance.generate('Hello');
    } catch (error) {
      caughtError = error as UPPError;
    }

    expect(caughtError).toBeInstanceOf(UPPError);
    expect(caughtError!.code).toBe(ErrorCode.AuthenticationFailed);
  });

  test('generate succeeds when model does not throw', async () => {
    const handler = createMockLLMHandler({ failCount: 0 });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const instance = llm({
      model: provider('test-model'),
    });

    const turn = await instance.generate('Hello');

    expect(turn.response.text).toBe('Success');
  });

  test('onError receives the original UPPError with correct code', async () => {
    const handler = createMockLLMHandler({
      failCount: 1,
      errorCode: ErrorCode.RateLimited,
    });

    const provider = createProvider({
      name: 'mock-gen',
      version: '1.0.0',
      handlers: { llm: handler },
    });

    const errorHookCalls: { error: Error }[] = [];

    const middleware: Middleware = {
      name: 'error-inspector',
      onError(error: Error, _ctx: MiddlewareContext) {
        errorHookCalls.push({ error });
      },
    };

    const instance = llm({
      model: provider('test-model'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10 }),
      },
      middleware: [middleware],
    });

    try {
      await instance.generate('Hello');
    } catch {
      // Expected
    }

    expect(errorHookCalls.length).toBe(1);
    const err = errorHookCalls[0]!.error as UPPError;
    expect(err.code).toBe(ErrorCode.RateLimited);
  });
});
