import { describe, expect, test } from 'bun:test';
import { llm } from '../../../../src/core/llm.ts';
import { exponentialBackoff, noRetry } from '../../../../src/http/retry.ts';
import { ErrorCode, ModalityType, UPPError } from '../../../../src/types/errors.ts';
import { StreamEventType, textDelta } from '../../../../src/types/stream.ts';
import { createTextResponse, createMockLLMProvider } from '../../../helpers/mock-llm-provider.ts';

describe('LLM streaming retry contracts', () => {
  test('retries stream after retryable provider errors and emits stream_retry', async () => {
    const provider = createMockLLMProvider({
      onStream: (_request, attempt) => {
        if (attempt === 1) {
          return {
            events: [textDelta('partial ')],
            error: new UPPError(
              'Temporary outage',
              ErrorCode.ProviderError,
              'mock',
              ModalityType.LLM,
            ),
          };
        }

        return {
          events: [textDelta('final response')],
          response: createTextResponse('final response'),
        };
      },
    });

    const model = llm({
      model: provider('mock-retry'),
      config: {
        retryStrategy: exponentialBackoff({
          maxAttempts: 2,
          baseDelay: 1,
          jitter: false,
        }),
      },
    });

    const stream = model.stream('Retry me');
    const eventTypes: string[] = [];

    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    const turn = await stream.turn;

    expect(turn.response.text).toBe('final response');
    expect(eventTypes.includes(StreamEventType.StreamRetry)).toBe(true);
    expect(eventTypes.filter((type) => type === StreamEventType.StreamRetry)).toHaveLength(1);
  });

  test('does not retry stream when noRetry strategy is configured', async () => {
    const provider = createMockLLMProvider({
      onStream: () => ({
        error: new UPPError(
          'No retries should happen',
          ErrorCode.ProviderError,
          'mock',
          ModalityType.LLM,
        ),
      }),
    });

    const model = llm({
      model: provider('mock-no-retry'),
      config: {
        retryStrategy: noRetry(),
      },
    });

    const stream = model.stream('Fail immediately');

    await expect(async () => {
      for await (const event of stream) {
        // Consume to trigger stream execution.
        void event;
      }
    }).toThrow(UPPError);

    await expect(stream.turn).rejects.toMatchObject({
      code: ErrorCode.ProviderError,
    });
  });
});
