import { test, expect, describe, beforeEach } from 'bun:test';
import {
  pubsubMiddleware,
  getStreamId,
  getAdapter,
  memoryAdapter,
} from '../../../../src/middleware/pubsub/index.ts';
import { createMiddlewareContext, createStreamContext } from '../../../../src/middleware/runner.ts';
import { textDelta } from '../../../../src/types/stream.ts';
import type { MiddlewareContext } from '../../../../src/types/middleware.ts';
import type { PubSubAdapter } from '../../../../src/middleware/pubsub/types.ts';

const createRequest = (): MiddlewareContext['request'] => ({
  messages: [],
  config: {},
});

describe('pubsubMiddleware', () => {
  let adapter: PubSubAdapter;

  beforeEach(() => {
    adapter = memoryAdapter();
  });

  describe('onStart', () => {
    test('stores stream ID in state when provided', () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'test-123' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);

      expect(getStreamId(ctx.state)).toBe('test-123');
    });

    test('stores adapter in state', () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'test-123' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);

      const storedAdapter = getAdapter(ctx.state);
      expect(storedAdapter).toBe(adapter);
    });

    test('does not set stream ID when not provided', () => {
      const mw = pubsubMiddleware({ adapter });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);

      expect(getStreamId(ctx.state)).toBeUndefined();
    });

    test('stream exists immediately after onStart (prevents duplicate generations)', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'early-exists' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      // Before onStart, stream should not exist
      const existsBefore = await adapter.exists('early-exists');
      expect(existsBefore).toBe(false);

      mw.onStart!(ctx);

      // After onStart (before any tokens), stream should exist
      const existsAfter = await adapter.exists('early-exists');
      expect(existsAfter).toBe(true);
    });
  });

  describe('onStreamEvent', () => {
    test('appends events to adapter (lazy stream creation)', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'buffer-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      const event = textDelta('Hello');
      mw.onStreamEvent!(event, streamCtx);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const events = await adapter.getEvents('buffer-stream');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    test('publishes events to subscribers', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'publish-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      const receivedEvents: unknown[] = [];
      adapter.subscribe('publish-stream', (e) => receivedEvents.push(e), () => {});

      const event = textDelta('Hello');
      mw.onStreamEvent!(event, streamCtx);

      // Wait for async append->publish chain to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toEqual(event);
    });

    test('passes through events unchanged', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'passthrough-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      const event = textDelta('Hello');
      const result = mw.onStreamEvent!(event, streamCtx);

      expect(result).toEqual(event);
    });

    test('does nothing when no streamId in state', async () => {
      const mw = pubsubMiddleware({ adapter });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      const event = textDelta('Hello');
      const result = mw.onStreamEvent!(event, streamCtx);

      // Event should pass through
      expect(result).toEqual(event);
    });
  });

  describe('onStreamEnd', () => {
    test('waits for pending appends but does not finalize (onTurn does)', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'complete-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      // Trigger lazy stream creation via append
      mw.onStreamEvent!(textDelta('Hello'), streamCtx);
      await new Promise((resolve) => setTimeout(resolve, 10));

      let completionNotified = false;
      adapter.subscribe('complete-stream', () => {}, () => {
        completionNotified = true;
      });

      await mw.onStreamEnd!(streamCtx);

      await Promise.resolve();

      // onStreamEnd should NOT finalize - onTurn does
      expect(completionNotified).toBe(false);
      const exists = await adapter.exists('complete-stream');
      expect(exists).toBe(true);
    });

    test('waits for pending appends before setting stream ended flag', async () => {
      let resolveAppend: () => void;
      let appendResolvedAt: number | null = null;

      const appendPromise = new Promise<void>((resolve) => {
        resolveAppend = () => {
          appendResolvedAt = Date.now();
          resolve();
        };
      });

      const base = memoryAdapter();
      const delayedAdapter: PubSubAdapter = {
        ...base,
        append: async (streamId, event) => {
          await appendPromise;
          await base.append(streamId, event);
        },
      };

      const mw = pubsubMiddleware({ adapter: delayedAdapter, streamId: 'pending-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      mw.onStreamEvent!(textDelta('Hello'), streamCtx);

      const endPromise = mw.onStreamEnd!(streamCtx);

      resolveAppend!();
      await endPromise;

      expect(appendResolvedAt).not.toBeNull();
      // Stream should still exist (onTurn hasn't been called yet)
      const exists = await delayedAdapter.exists('pending-stream');
      expect(exists).toBe(true);
    });

    test('does nothing when no streamId', async () => {
      const mw = pubsubMiddleware({ adapter });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      // Should not throw
      await mw.onStreamEnd!(streamCtx);
    });
  });

  describe('onTurn', () => {
    test('sets final data and removes stream after onStreamEnd', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'turn-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      // Trigger lazy stream creation via append
      mw.onStreamEvent!(textDelta('Hello'), streamCtx);
      await new Promise((resolve) => setTimeout(resolve, 10));

      let completionNotified = false;
      let receivedFinalData: unknown = undefined;
      adapter.subscribe('turn-stream', () => {}, () => {
        completionNotified = true;
      }, (data) => {
        receivedFinalData = data;
      });

      // Simulate stream end
      await mw.onStreamEnd!(streamCtx);

      // Stream should still exist
      expect(await adapter.exists('turn-stream')).toBe(true);
      expect(completionNotified).toBe(false);

      // Create a mock turn
      const { createTurn } = await import('../../../../src/types/turn.ts');
      const { AssistantMessage } = await import('../../../../src/types/messages.ts');
      const mockTurn = createTurn(
        [new AssistantMessage([{ type: 'text', text: 'Hello!' }])],
        [],
        { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        1
      );

      // Call onTurn
      await mw.onTurn!(mockTurn, ctx);

      // Wait for microtasks
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Now stream should be removed and completion notified
      expect(await adapter.exists('turn-stream')).toBe(false);
      expect(completionNotified).toBe(true);
      expect(receivedFinalData).toBeDefined();
      expect((receivedFinalData as { messages: unknown[] }).messages).toBeDefined();
    });

    test('does nothing when no streamId', async () => {
      const mw = pubsubMiddleware({ adapter });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);

      const { createTurn } = await import('../../../../src/types/turn.ts');
      const { AssistantMessage } = await import('../../../../src/types/messages.ts');
      const mockTurn = createTurn(
        [new AssistantMessage([{ type: 'text', text: 'Hello!' }])],
        [],
        { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        1
      );

      // Should not throw
      await mw.onTurn!(mockTurn, ctx);
    });

    test('cleans up orphan stream and warns when generate() used with streamId', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'generate-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', false, createRequest());

      mw.onStart!(ctx);

      // Stream should exist after onStart
      expect(await adapter.exists('generate-stream')).toBe(true);

      const { createTurn } = await import('../../../../src/types/turn.ts');
      const { AssistantMessage } = await import('../../../../src/types/messages.ts');
      const mockTurn = createTurn(
        [new AssistantMessage([{ type: 'text', text: 'Hello!' }])],
        [],
        { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        1
      );

      // Capture console.warn
      const originalWarn = console.warn;
      let warnMessage = '';
      console.warn = (msg: string) => { warnMessage = msg; };

      // Call onTurn without onStreamEnd (simulating generate)
      await mw.onTurn!(mockTurn, ctx);

      // Restore console.warn
      console.warn = originalWarn;

      // Should have warned about misuse
      expect(warnMessage).toContain('streamId "generate-stream" was configured');
      expect(warnMessage).toContain('.generate() was used instead of .stream()');

      // Stream should be cleaned up
      expect(await adapter.exists('generate-stream')).toBe(false);
    });
  });

  describe('onError', () => {
    test('notifies subscribers and removes stream on error', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'error-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      // Trigger lazy stream creation
      mw.onStreamEvent!(textDelta('Hello'), streamCtx);
      await new Promise((resolve) => setTimeout(resolve, 10));

      let completionNotified = false;
      adapter.subscribe('error-stream', () => {}, () => {
        completionNotified = true;
      });

      await mw.onError!(new Error('test error'), ctx);

      await Promise.resolve();

      expect(completionNotified).toBe(true);
      const exists = await adapter.exists('error-stream');
      expect(exists).toBe(false);
    });

    test('does nothing when no streamId', async () => {
      const mw = pubsubMiddleware({ adapter });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);

      // Should not throw
      await mw.onError!(new Error('test error'), ctx);
    });
  });

  describe('onAbort', () => {
    test('notifies subscribers and removes stream on abort', async () => {
      const mw = pubsubMiddleware({ adapter, streamId: 'abort-stream' });
      const ctx = createMiddlewareContext('llm', 'claude-3', 'anthropic', true, createRequest());

      mw.onStart!(ctx);
      const streamCtx = createStreamContext(ctx.state);

      // Trigger lazy stream creation
      mw.onStreamEvent!(textDelta('Hello'), streamCtx);
      await new Promise((resolve) => setTimeout(resolve, 10));

      let completionNotified = false;
      adapter.subscribe('abort-stream', () => {}, () => {
        completionNotified = true;
      });

      await mw.onAbort!(new Error('abort'), ctx);

      await Promise.resolve();

      expect(completionNotified).toBe(true);
      const exists = await adapter.exists('abort-stream');
      expect(exists).toBe(false);
    });
  });

  describe('middleware properties', () => {
    test('has correct name', () => {
      const mw = pubsubMiddleware({ adapter });
      expect(mw.name).toBe('pubsub');
    });
  });
});

describe('getStreamId', () => {
  test('returns undefined for empty state', () => {
    const state = new Map<string, unknown>();
    expect(getStreamId(state)).toBeUndefined();
  });

  test('returns stream ID when set', () => {
    const state = new Map<string, unknown>();
    state.set('pubsub:streamId', 'test-123');
    expect(getStreamId(state)).toBe('test-123');
  });
});

describe('getAdapter', () => {
  test('returns undefined for empty state', () => {
    const state = new Map<string, unknown>();
    expect(getAdapter(state)).toBeUndefined();
  });

  test('returns adapter when set', () => {
    const adapter = memoryAdapter();
    const state = new Map<string, unknown>();
    state.set('pubsub:adapter', adapter);
    expect(getAdapter(state)).toBe(adapter);
  });
});
