import { describe, expect, test } from 'bun:test';
import {
  isPipelineStageEvent,
  pipelineMiddleware,
  pipelineStageEvent,
  type PipelineStage,
} from '../../../../src/middleware/pipeline/index.ts';
import { createMiddlewareContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { AssistantMessage } from '../../../../src/types/messages.ts';
import type { StreamEvent } from '../../../../src/types/stream.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';

function createLLMRequest(): LLMRequest {
  return {
    messages: [],
    config: {} as LLMRequest['config'],
  };
}

function createTurnContext(emittedEvents: StreamEvent[]) {
  return createMiddlewareContext(
    'llm',
    'mock-model',
    'mock-provider',
    true,
    createLLMRequest(),
    {
      fn: (event: StreamEvent): void => {
        emittedEvents.push(event);
      },
    },
  );
}

function createCompletedTurn() {
  return createTurn(
    [new AssistantMessage('pipeline complete')],
    [],
    emptyUsage(),
    1,
  );
}

describe('Pipeline middleware contracts', () => {
  test('emits pipeline stage events with stable stage + payload shape', async () => {
    const emittedEvents: StreamEvent[] = [];

    const middleware = pipelineMiddleware({
      stages: [
        {
          type: 'slug',
          run: (_turn, emit) => {
            emit({ slug: 'contract-test' });
          },
        },
        {
          type: 'embedding',
          run: (_turn, emit) => {
            emit({ vectorized: true });
          },
        },
      ],
    });

    const expectedShape = pipelineStageEvent('shape-check', { ok: true });
    expect(isPipelineStageEvent(expectedShape)).toBe(true);

    await middleware.onTurn!(createCompletedTurn(), createTurnContext(emittedEvents));

    const stageEvents = emittedEvents.filter(isPipelineStageEvent);
    expect(stageEvents.map((event) => event.delta.stage)).toEqual(['slug', 'embedding']);
    expect(stageEvents[0]?.delta.payload).toEqual({ slug: 'contract-test' });
    expect(stageEvents[1]?.delta.payload).toEqual({ vectorized: true });
  });

  test('stops on first stage error by default and surfaces onStageError details', async () => {
    const emittedEvents: StreamEvent[] = [];
    const stageRuns: string[] = [];
    const stageErrors: string[] = [];

    const stages: PipelineStage[] = [
      {
        type: 'first',
        run: () => {
          stageRuns.push('first');
          throw new Error('first failed');
        },
      },
      {
        type: 'second',
        run: () => {
          stageRuns.push('second');
        },
      },
    ];

    const middleware = pipelineMiddleware({
      stages,
      onStageError: ({ stage, error }) => {
        stageErrors.push(`${stage.type}:${error.message}`);
      },
    });

    await expect(
      middleware.onTurn!(createCompletedTurn(), createTurnContext(emittedEvents)),
    ).rejects.toThrow('first failed');

    expect(stageRuns).toEqual(['first']);
    expect(stageErrors).toEqual(['first:first failed']);
    expect(emittedEvents).toHaveLength(0);
  });

  test('continues running later stages when continueOnError is enabled', async () => {
    const emittedEvents: StreamEvent[] = [];
    const stageRuns: string[] = [];
    const stageErrors: string[] = [];

    const middleware = pipelineMiddleware({
      continueOnError: true,
      onStageError: ({ stage, error }) => {
        stageErrors.push(`${stage.type}:${error.message}`);
      },
      stages: [
        {
          type: 'first',
          run: () => {
            stageRuns.push('first');
            throw new Error('first failed');
          },
        },
        {
          type: 'second',
          run: (_turn, emit) => {
            stageRuns.push('second');
            emit({ completed: true });
          },
        },
      ],
    });

    await middleware.onTurn!(createCompletedTurn(), createTurnContext(emittedEvents));

    const stageEvents = emittedEvents.filter(isPipelineStageEvent);
    expect(stageRuns).toEqual(['first', 'second']);
    expect(stageErrors).toEqual(['first:first failed']);
    expect(stageEvents.map((event) => event.delta.stage)).toEqual(['second']);
    expect(stageEvents[0]?.delta.payload).toEqual({ completed: true });
  });
});
