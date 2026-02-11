import { describe, expect, test } from 'bun:test';
import { llm } from '../../../../src/core/llm.ts';
import { runTurnHook } from '../../../../src/middleware/runner.ts';
import { StreamEventType, textDelta, type StreamEvent } from '../../../../src/types/stream.ts';
import { AssistantMessage } from '../../../../src/types/messages.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';
import type { Middleware, MiddlewareContext } from '../../../../src/types/middleware.ts';
import {
  createMockLLMProvider,
  createTextResponse,
} from '../../../helpers/mock-llm-provider.ts';

describe('Middleware contracts', () => {
  test('executes lifecycle hooks in documented order', async () => {
    const order: string[] = [];

    const first: Middleware = {
      name: 'first',
      onStart() {
        order.push('first:start');
      },
      onRequest() {
        order.push('first:request');
      },
      onResponse() {
        order.push('first:response');
      },
      onTurn() {
        order.push('first:turn');
      },
      onEnd() {
        order.push('first:end');
      },
    };

    const second: Middleware = {
      name: 'second',
      onStart() {
        order.push('second:start');
      },
      onRequest() {
        order.push('second:request');
      },
      onResponse() {
        order.push('second:response');
      },
      onTurn() {
        order.push('second:turn');
      },
      onEnd() {
        order.push('second:end');
      },
    };

    const provider = createMockLLMProvider({
      onComplete: () => ({
        response: createTextResponse('done'),
      }),
    });

    const model = llm({
      model: provider('mock-middleware-order'),
      middleware: [first, second],
    });

    const turn = await model.generate('Ping');

    expect(turn.response.text).toBe('done');
    expect(order).toEqual([
      'first:start',
      'second:start',
      'first:request',
      'second:request',
      'second:response',
      'first:response',
      'second:turn',
      'first:turn',
      'second:end',
      'first:end',
    ]);
  });

  test('applies onStreamEvent transformations and filtering', async () => {
    const provider = createMockLLMProvider({
      onStream: () => ({
        events: [
          textDelta('drop'),
          textDelta('keep'),
        ],
        response: createTextResponse('keep'),
      }),
    });

    const streamMiddleware: Middleware = {
      name: 'stream-filter',
      onStreamEvent(event: StreamEvent) {
        if (event.type === StreamEventType.TextDelta && event.delta.text === 'drop') {
          return null;
        }

        if (event.type === StreamEventType.TextDelta && event.delta.text === 'keep') {
          return [
            event,
            textDelta('!'),
          ];
        }

        return event;
      },
    };

    const model = llm({
      model: provider('mock-stream-transform'),
      middleware: [streamMiddleware],
    });

    const stream = model.stream('Stream test');
    const chunks: string[] = [];

    for await (const event of stream) {
      if (event.type === StreamEventType.TextDelta && event.delta.text) {
        chunks.push(event.delta.text);
      }
    }

    const turn = await stream.turn;

    expect(chunks).toEqual(['keep', '!']);
    expect(turn.response.text).toBe('keep');
  });

  test('runTurnHook executes all middleware even when one throws and re-throws first error', async () => {
    const executed: string[] = [];

    const throwingMiddleware: Middleware = {
      name: 'thrower',
      onTurn() {
        executed.push('thrower');
        throw new Error('stage failed');
      },
    };

    const cleanupMiddleware: Middleware = {
      name: 'cleanup',
      onTurn() {
        executed.push('cleanup');
      },
    };

    const turn = createTurn(
      [new AssistantMessage('done')],
      [],
      emptyUsage(),
      1,
    );

    const ctx = {
      state: new Map(),
    } as MiddlewareContext;

    await expect(
      runTurnHook([throwingMiddleware, cleanupMiddleware], turn, ctx),
    ).rejects.toThrow('stage failed');

    expect(executed).toEqual(['cleanup', 'thrower']);
  });

  test('runTurnHook re-throws first error when multiple middleware throw', async () => {
    const first: Middleware = {
      name: 'first-thrower',
      onTurn() {
        throw new Error('first error');
      },
    };

    const second: Middleware = {
      name: 'second-thrower',
      onTurn() {
        throw new Error('second error');
      },
    };

    const turn = createTurn(
      [new AssistantMessage('done')],
      [],
      emptyUsage(),
      1,
    );

    const ctx = { state: new Map() } as MiddlewareContext;

    // runTurnHook reverses order, so 'second-thrower' runs first
    await expect(
      runTurnHook([first, second], turn, ctx),
    ).rejects.toThrow('second error');
  });
});
