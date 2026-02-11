import { describe, expect, test } from 'bun:test';
import { parsedObjectMiddleware } from '../../../../src/middleware/parsed-object.ts';
import { createMiddlewareContext, createStreamContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { objectDelta, textDelta, toolCallDelta } from '../../../../src/types/stream.ts';

function createLLMRequest(): LLMRequest {
  return {
    messages: [],
    config: {} as LLMRequest['config'],
  };
}

describe('Parsed object middleware contracts', () => {
  test('incrementally parses object deltas per index', () => {
    const middleware = parsedObjectMiddleware();
    const streamContext = createStreamContext(new Map());

    middleware.onStreamEvent?.(objectDelta('{"first":"A'), streamContext);
    const second = middleware.onStreamEvent?.(objectDelta('da"}'), streamContext);

    expect(Array.isArray(second)).toBe(false);
    expect(second).not.toBeNull();
    if (second && !Array.isArray(second)) {
      expect(second.delta).toMatchObject({
        parsed: { first: 'Ada' },
      });
    }

    middleware.onStreamEvent?.(objectDelta('{"first":"G', 1), streamContext);
    const otherIndex = middleware.onStreamEvent?.(objectDelta('race"}', 1), streamContext);
    if (otherIndex && !Array.isArray(otherIndex)) {
      expect(otherIndex.index).toBe(1);
      expect(otherIndex.delta).toMatchObject({
        parsed: { first: 'Grace' },
      });
    }
  });

  test('incrementally parses tool call argument JSON', () => {
    const middleware = parsedObjectMiddleware();
    const streamContext = createStreamContext(new Map());

    middleware.onStreamEvent?.(toolCallDelta('call-1', 'sum', '{"a":2,'), streamContext);
    const next = middleware.onStreamEvent?.(toolCallDelta('call-1', 'sum', '"b":3}'), streamContext);

    expect(next).not.toBeNull();
    if (next && !Array.isArray(next)) {
      expect(next.delta).toMatchObject({
        parsed: { a: 2, b: 3 },
      });
    }
  });

  test('resets accumulated state on retry and stream end', () => {
    const middleware = parsedObjectMiddleware();
    const middlewareContext = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      true,
      createLLMRequest(),
    );
    const streamContext = createStreamContext(middlewareContext.state);

    middleware.onStreamEvent?.(objectDelta('{"a":1'), streamContext);
    middleware.onStreamEvent?.(toolCallDelta('call-1', 'sum', '{"b":2'), streamContext);
    expect(middlewareContext.state.size).toBeGreaterThan(0);

    middleware.onRetry?.(1, new Error('retry'), middlewareContext);
    expect(middlewareContext.state.size).toBe(0);

    middleware.onStreamEvent?.(objectDelta('{"x":1}'), streamContext);
    expect(middlewareContext.state.size).toBeGreaterThan(0);

    middleware.onStreamEnd?.(streamContext);
    expect(middlewareContext.state.size).toBe(0);
  });

  test('passes through non-targeted stream events', () => {
    const middleware = parsedObjectMiddleware();
    const streamContext = createStreamContext(new Map());
    const input = textDelta('hello');
    const output = middleware.onStreamEvent?.(input, streamContext);

    expect(output).toEqual(input);
  });
});
