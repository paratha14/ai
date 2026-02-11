import { createProvider } from '../../src/core/provider.ts';
import { AssistantMessage } from '../../src/types/messages.ts';
import { textDelta } from '../../src/types/stream.ts';
import type { LLMCapabilities, LLMRequest, LLMResponse } from '../../src/types/llm.ts';
import type { Provider, LLMHandler, LLMProvider } from '../../src/types/provider.ts';
import type { StreamEvent } from '../../src/types/stream.ts';
import type { TokenUsage } from '../../src/types/turn.ts';

/**
 * Result of one mocked non-streaming completion attempt.
 */
export interface MockCompleteAttempt<TParams> {
  response?: LLMResponse;
  error?: Error;
  onRequest?: (request: LLMRequest<TParams>) => void;
}

/**
 * Result of one mocked streaming completion attempt.
 */
export interface MockStreamAttempt<TParams> {
  events?: StreamEvent[];
  response?: LLMResponse;
  error?: Error;
  onRequest?: (request: LLMRequest<TParams>) => void;
}

/**
 * Configuration for creating a mock LLM provider.
 */
export interface MockLLMProviderOptions<TParams> {
  name?: string;
  capabilities?: Partial<LLMCapabilities>;
  onComplete?: (
    request: LLMRequest<TParams>,
    attempt: number,
  ) => MockCompleteAttempt<TParams> | Promise<MockCompleteAttempt<TParams>>;
  onStream?: (
    request: LLMRequest<TParams>,
    attempt: number,
  ) => MockStreamAttempt<TParams> | Promise<MockStreamAttempt<TParams>>;
}

const DEFAULT_CAPABILITIES: LLMCapabilities = {
  streaming: true,
  tools: true,
  structuredOutput: true,
  imageInput: false,
  documentInput: false,
  videoInput: false,
  audioInput: false,
};

/**
 * Creates token usage for test responses.
 */
export function createUsage(inputTokens = 10, outputTokens = 10): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Creates a plain text LLM response for tests.
 */
export function createTextResponse(text: string, usage = createUsage()): LLMResponse {
  return {
    message: new AssistantMessage(text),
    usage,
    stopReason: 'stop',
  };
}

/**
 * Creates a mock provider for deterministic LLM contract tests.
 */
export function createMockLLMProvider<TParams = Record<string, never>>(
  options: MockLLMProviderOptions<TParams> = {},
): Provider<TParams> {
  let providerRef: LLMProvider<TParams> | null = null;
  let completeAttempts = 0;
  let streamAttempts = 0;

  const capabilities: LLMCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...options.capabilities,
  };

  const handler: LLMHandler<TParams> = {
    _setProvider(provider: LLMProvider<TParams>) {
      providerRef = provider;
    },
    bind(modelId: string) {
      if (!providerRef) {
        throw new Error('Mock provider was not initialized');
      }

      return {
        modelId,
        capabilities,
        get provider() {
          return providerRef as LLMProvider<TParams>;
        },
        async complete(request: LLMRequest<TParams>): Promise<LLMResponse> {
          completeAttempts += 1;
          const attempt = await options.onComplete?.(request, completeAttempts) ?? {
            response: createTextResponse(`complete-${completeAttempts}`),
          };

          attempt.onRequest?.(request);

          if (attempt.error) {
            throw attempt.error;
          }

          return attempt.response ?? createTextResponse(`complete-${completeAttempts}`);
        },
        stream(request: LLMRequest<TParams>) {
          streamAttempts += 1;

          const streamResponse = (async () => {
            const attempt = await options.onStream?.(request, streamAttempts) ?? {
              events: [textDelta(`stream-${streamAttempts}`)],
              response: createTextResponse(`stream-${streamAttempts}`),
            };

            attempt.onRequest?.(request);

            return attempt;
          })();

          return {
            async *[Symbol.asyncIterator]() {
              const attempt = await streamResponse;
              for (const event of attempt.events ?? []) {
                yield event;
              }
              if (attempt.error) {
                throw attempt.error;
              }
            },
            response: streamResponse.then((attempt) => (
              attempt.response ?? createTextResponse(`stream-${streamAttempts}`)
            )),
          };
        },
      };
    },
  };

  return createProvider<TParams>({
    name: options.name ?? 'mock',
    version: '1.0.0',
    handlers: {
      llm: handler,
    },
  });
}
