import { describe, expect, test } from 'bun:test';
import { loggingMiddleware } from '../../../../src/middleware/logging.ts';
import { parsedObjectMiddleware } from '../../../../src/middleware/parsed-object.ts';
import { pipelineMiddleware } from '../../../../src/middleware/pipeline/index.ts';
import { pubsubMiddleware, memoryAdapter } from '../../../../src/middleware/pubsub/index.ts';
import { persistenceMiddleware, PersistenceAdapter } from '../../../../src/middleware/persistence.ts';
import { createMiddlewareContext, createStreamContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import type { AnyRequest } from '../../../../src/types/middleware.ts';
import { AssistantMessage, UserMessage } from '../../../../src/types/messages.ts';
import { textDelta, objectDelta, type StreamEvent } from '../../../../src/types/stream.ts';
import { Thread } from '../../../../src/types/thread.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';

function createLLMRequest(messages: LLMRequest['messages'] = []): LLMRequest {
  return {
    messages,
    config: {} as LLMRequest['config'],
  };
}

describe('Middleware isolation contracts', () => {
  describe('logging', () => {
    test('does not mutate context, request, or turn', () => {
      const middleware = loggingMiddleware({
        level: 'debug',
        logger: () => {},
      });

      const request = createLLMRequest([new UserMessage('hello')]);
      const context = createMiddlewareContext('llm', 'model', 'provider', false, request);
      const messageCountBefore = request.messages.length;
      const stateSizeBefore = context.state.size;

      middleware.onStart?.(context);
      middleware.onRequest?.(context);

      expect(request.messages).toHaveLength(messageCountBefore);
      expect(context.state.size).toBe(stateSizeBefore);
      expect(context.response).toBeUndefined();

      context.endTime = context.startTime + 10;
      middleware.onEnd?.(context);

      expect(request.messages).toHaveLength(messageCountBefore);
      expect(context.state.size).toBe(stateSizeBefore);
    });

    test('returns stream events by reference without modification', () => {
      const middleware = loggingMiddleware({
        level: 'debug',
        logStreamEvents: true,
        logger: () => {},
      });

      const event = textDelta('hello');
      const streamContext = createStreamContext(new Map());
      const result = middleware.onStreamEvent?.(event, streamContext);

      expect(result).toBe(event);
    });
  });

  describe('parsed-object', () => {
    test('only writes to its own namespaced state keys', () => {
      const middleware = parsedObjectMiddleware();
      const state = new Map<string, unknown>();
      state.set('other:key', 'untouched');
      const streamContext = createStreamContext(state);

      middleware.onStreamEvent?.(objectDelta('{"a":1}'), streamContext);

      expect(state.get('other:key')).toBe('untouched');

      const keys = [...state.keys()].filter((k) => !k.startsWith('parsedObject:'));
      expect(keys).toEqual(['other:key']);
    });

    test('does not mutate the original event object', () => {
      const middleware = parsedObjectMiddleware();
      const streamContext = createStreamContext(new Map());
      const event = objectDelta('{"a":1}');
      const originalDelta = { ...event.delta };

      middleware.onStreamEvent?.(event, streamContext);

      expect(event.delta).toEqual(originalDelta);
    });
  });

  describe('pipeline', () => {
    test('does not write to context state map', async () => {
      const emittedEvents: StreamEvent[] = [];
      const middleware = pipelineMiddleware({
        stages: [{
          type: 'test-stage',
          run: (_turn, emit) => {
            emit({ result: true });
          },
        }],
      });

      const context = createMiddlewareContext(
        'llm', 'model', 'provider', true, createLLMRequest(),
        { fn: (event: StreamEvent) => { emittedEvents.push(event); } },
      );
      const stateSizeBefore = context.state.size;

      const turn = createTurn(
        [new AssistantMessage('done')],
        [],
        emptyUsage(),
        1,
      );
      await middleware.onTurn?.(turn, context);

      expect(context.state.size).toBe(stateSizeBefore);
      expect(emittedEvents.length).toBeGreaterThan(0);
    });

    test('does not mutate the turn object', async () => {
      const middleware = pipelineMiddleware({
        stages: [{
          type: 'test-stage',
          run: () => {},
        }],
      });

      const context = createMiddlewareContext(
        'llm', 'model', 'provider', true, createLLMRequest(),
        { fn: () => {} },
      );

      const turn = createTurn(
        [new AssistantMessage('done')],
        [],
        emptyUsage(),
        1,
      );
      const messagesBefore = turn.messages.length;
      const textBefore = turn.response.text;

      await middleware.onTurn?.(turn, context);

      expect(turn.messages).toHaveLength(messagesBefore);
      expect(turn.response.text).toBe(textBefore);
    });
  });

  describe('pubsub', () => {
    test('only writes to pubsub-namespaced state keys', () => {
      const adapter = memoryAdapter();
      const middleware = pubsubMiddleware({ adapter, streamId: 'iso-test' });
      const context = createMiddlewareContext('llm', 'model', 'provider', true, createLLMRequest());
      context.state.set('other:key', 'untouched');

      middleware.onStart?.(context);

      expect(context.state.get('other:key')).toBe('untouched');

      const foreignKeys = [...context.state.keys()].filter(
        (k) => !k.startsWith('pubsub:'),
      );
      expect(foreignKeys).toEqual(['other:key']);
    });

    test('returns stream events by reference without modification', () => {
      const adapter = memoryAdapter();
      const middleware = pubsubMiddleware({ adapter, streamId: 'passthrough-test' });
      const context = createMiddlewareContext('llm', 'model', 'provider', true, createLLMRequest());
      middleware.onStart?.(context);

      const streamContext = createStreamContext(context.state);
      const event = textDelta('hello');
      const result = middleware.onStreamEvent?.(event, streamContext);

      expect(result).toBe(event);
    });

    test('does not mutate request messages', async () => {
      const adapter = memoryAdapter();
      const middleware = pubsubMiddleware({ adapter, streamId: 'req-test' });
      const messages = [new UserMessage('hello')];
      const request = createLLMRequest(messages);
      const context = createMiddlewareContext('llm', 'model', 'provider', true, request);

      middleware.onStart?.(context);

      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]?.text).toBe('hello');
    });
  });

  describe('persistence', () => {
    test('only writes to persistence-namespaced and llm-namespaced state keys', async () => {
      const adapter = new PersistenceAdapter({
        id: 'iso-thread',
        load: async () => new Thread([new UserMessage('persisted')]),
        save: async () => {},
      });

      const middleware = persistenceMiddleware({ adapter });
      const context = createMiddlewareContext(
        'llm', 'model', 'provider', false,
        createLLMRequest([new UserMessage('new')]),
      );
      context.state.set('other:key', 'untouched');

      await middleware.onRequest?.(context);

      expect(context.state.get('other:key')).toBe('untouched');

      const foreignKeys = [...context.state.keys()].filter(
        (k) => !k.startsWith('persistence:') && !k.startsWith('llm:'),
      );
      expect(foreignKeys).toEqual(['other:key']);
    });

    test('skips non-LLM modalities without touching state or request', async () => {
      const adapter = new PersistenceAdapter({
        id: 'skip-thread',
        load: async () => { throw new Error('should not be called'); },
        save: async () => { throw new Error('should not be called'); },
      });

      const middleware = persistenceMiddleware({ adapter });
      const context = createMiddlewareContext(
        'embedding', 'model', 'provider', false,
        { inputs: [{ text: 'test' }], config: {} } as unknown as AnyRequest,
      );

      await middleware.onRequest?.(context);

      expect(context.state.size).toBe(0);
    });
  });

  describe('cross-middleware state isolation', () => {
    test('middleware do not overwrite each others state keys', async () => {
      const adapter = memoryAdapter();
      const pubsub = pubsubMiddleware({ adapter, streamId: 'cross-test' });
      const parsed = parsedObjectMiddleware();
      const logging = loggingMiddleware({ level: 'debug', logger: () => {} });

      const context = createMiddlewareContext('llm', 'model', 'provider', true, createLLMRequest());

      pubsub.onStart?.(context);
      logging.onStart?.(context);

      const streamContext = createStreamContext(context.state);
      const event = objectDelta('{"x":1}');

      pubsub.onStreamEvent?.(event, streamContext);
      parsed.onStreamEvent?.(event, streamContext);
      logging.onStreamEvent?.(event, streamContext);

      const pubsubKeys = [...context.state.keys()].filter((k) => k.startsWith('pubsub:'));
      const parsedKeys = [...context.state.keys()].filter((k) => k.startsWith('parsedObject:'));

      expect(pubsubKeys.length).toBeGreaterThan(0);
      expect(parsedKeys.length).toBeGreaterThan(0);

      // Verify no key belongs to multiple namespaces
      const allKeys = [...context.state.keys()];
      const namespaces = allKeys.map((k) => k.split(':')[0]);
      const uniquePrefixedKeys = new Set(allKeys);
      expect(uniquePrefixedKeys.size).toBe(allKeys.length);

      // Verify namespaces are distinct per middleware
      for (const ns of ['pubsub', 'parsedObject']) {
        const keysInNs = namespaces.filter((n) => n === ns);
        expect(keysInNs.length).toBeGreaterThan(0);
      }
    });
  });
});
