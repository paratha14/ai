/**
 * @fileoverview Pub-sub middleware for stream resumption.
 *
 * Enables reconnecting clients to catch up on missed events during
 * active generation. The middleware buffers events and publishes them
 * to subscribers. Server routes handle reconnection logic using the
 * exported `createSubscriberStream` utility.
 *
 * @module middleware/pubsub
 */

import type {
  Middleware,
  MiddlewareContext,
  StreamContext,
} from '../../types/middleware.ts';
import type { StreamEvent } from '../../types/stream.ts';
import type { Turn } from '../../types/turn.ts';
import type { PubSubAdapter, PubSubOptions } from './types.ts';
import { memoryAdapter } from './memory-adapter.ts';
import { serializeTurn } from '../../providers/proxy/serialization.ts';

export type {
  PubSubAdapter,
  PubSubOptions,
  StoredStream,
  SubscriptionCallback,
  CompletionCallback,
  FinalDataCallback,
  Unsubscribe,
  MemoryAdapterOptions,
} from './types.ts';
export { memoryAdapter } from './memory-adapter.ts';

const STATE_KEY_STREAM_ID = 'pubsub:streamId';
const STATE_KEY_ADAPTER = 'pubsub:adapter';
const STATE_KEY_STREAM_ENDED = 'pubsub:streamEnded';

interface AppendChainState {
  chain: Promise<void>;
}

/**
 * Gets the stream ID from middleware state.
 *
 * @param state - Middleware state map
 * @returns Stream ID or undefined if not set
 */
export function getStreamId(state: Map<string, unknown>): string | undefined {
  return state.get(STATE_KEY_STREAM_ID) as string | undefined;
}

/**
 * Gets the adapter from middleware state.
 *
 * @param state - Middleware state map
 * @returns Adapter or undefined if not set
 */
export function getAdapter(state: Map<string, unknown>): PubSubAdapter | undefined {
  return state.get(STATE_KEY_ADAPTER) as PubSubAdapter | undefined;
}

/**
 * Creates pub-sub middleware for stream buffering and publishing.
 *
 * The middleware:
 * - Creates stream entries for new requests
 * - Buffers all stream events
 * - Publishes events to subscribers
 * - On stream end: notifies subscribers, then removes from adapter
 *
 * Server routes handle reconnection logic using `streamSubscriber`.
 *
 * @param options - Middleware configuration
 * @returns Middleware instance
 *
 * @example
 * ```typescript
 * import { llm } from '@providerprotocol/ai';
 * import { anthropic } from '@providerprotocol/ai/anthropic';
 * import { pubsubMiddleware, memoryAdapter } from '@providerprotocol/ai/middleware/pubsub';
 * import { h3 } from '@providerprotocol/ai/middleware/pubsub/server';
 *
 * const adapter = memoryAdapter();
 *
 * export default defineEventHandler(async (event) => {
 *   const { input, conversationId } = await readBody(event);
 *
 *   // Guard: prevent duplicate generations on reconnect
 *   if (!await adapter.exists(conversationId)) {
 *     const model = llm({
 *       model: anthropic('claude-sonnet-4-20250514'),
 *       middleware: [pubsubMiddleware({ adapter, streamId: conversationId })],
 *     });
 *     model.stream(input).then(turn => saveToDatabase(turn));
 *   }
 *
 *   return h3.streamSubscriber(conversationId, adapter, event);
 * });
 * ```
 */
export function pubsubMiddleware(options: PubSubOptions = {}): Middleware {
  const {
    adapter = memoryAdapter(),
    streamId,
  } = options;

  const appendChains = new Map<string, AppendChainState>();

  const enqueueAppend = (id: string, event: StreamEvent): void => {
    const state = appendChains.get(id) ?? { chain: Promise.resolve() };

    const task = state.chain
      .catch(() => {})
      .then(async () => {
        await adapter.append(id, event);
        adapter.publish(id, event);
      });

    state.chain = task.catch(() => {});
    appendChains.set(id, state);
  };

  const waitForAppends = async (id: string): Promise<void> => {
    const state = appendChains.get(id);
    if (!state) {
      return;
    }

    await state.chain.catch(() => {});
  };

  const clearAppendState = (id: string): void => {
    appendChains.delete(id);
  };

  /**
   * Finalizes a stream by marking completion and removing from adapter.
   *
   * Called on any terminal state (complete, error, abort). After finalization,
   * the stream is removed from the adapter. Apps should use `.then()` to persist
   * completed conversations and serve them from their own storage on reconnect.
   */
  const finalizeStreamByState = async (state: Map<string, unknown>): Promise<void> => {
    const id = state.get(STATE_KEY_STREAM_ID) as string | undefined;
    if (!id) {
      return;
    }

    await waitForAppends(id);
    clearAppendState(id);

    // Remove from adapter (notifies subscribers) - apps persist via .then()
    await adapter.remove(id).catch(() => {});
  };

  return {
    name: 'pubsub',

    onStart(ctx: MiddlewareContext): void {
      ctx.state.set(STATE_KEY_ADAPTER, adapter);

      if (streamId) {
        ctx.state.set(STATE_KEY_STREAM_ID, streamId);
        // Ensure stream exists immediately so exists() returns true
        // before first token arrives (prevents duplicate generations)
        adapter.subscribe(streamId, () => {}, () => {})();
      }
    },

    onStreamEvent(event: StreamEvent, ctx: StreamContext): StreamEvent {
      const id = ctx.state.get(STATE_KEY_STREAM_ID) as string | undefined;
      if (!id) {
        return event;
      }

      enqueueAppend(id, event);

      return event;
    },

    async onStreamEnd(ctx: StreamContext): Promise<void> {
      const id = ctx.state.get(STATE_KEY_STREAM_ID) as string | undefined;
      if (!id) {
        return;
      }
      // Wait for all stream-phase appends to complete
      await waitForAppends(id);
      // Clear append state to prevent memory leaks if onTurn is skipped or fails.
      // Other middleware may emit during onTurn - those get new append chains.
      clearAppendState(id);
      ctx.state.set(STATE_KEY_STREAM_ENDED, true);
    },

    async onTurn(turn: Turn, ctx: MiddlewareContext): Promise<void> {
      const id = ctx.state.get(STATE_KEY_STREAM_ID) as string | undefined;
      const streamEnded = ctx.state.get(STATE_KEY_STREAM_ENDED) as boolean | undefined;

      if (!id) {
        return;
      }

      // Only emit Turn if we were streaming (onStreamEnd was called)
      if (streamEnded) {
        // Wait for any late appends from other middleware that emitted during onTurn
        // (e.g., pipeline middleware emits events before pubsub's onTurn runs).
        // These create new append chains since onStreamEnd cleared the stream-phase chains.
        await waitForAppends(id);
        clearAppendState(id);
        // Set the final Turn data so subscribers receive it before completion
        adapter.setFinalData(id, serializeTurn(turn));
        // Now remove the stream (notifies subscribers with final data + completion)
        await adapter.remove(id).catch(() => {});
      } else {
        // streamId was set but .generate() was used instead of .stream()
        // Clean up the orphan stream entry and warn about misuse
        const exists = await adapter.exists(id);
        if (exists) {
          console.warn(
            `[pubsub] streamId "${id}" was configured but .generate() was used instead of .stream(). ` +
            `Pubsub middleware only works with streaming. Cleaning up orphan stream.`
          );
          await adapter.remove(id).catch(() => {});
        }
      }
    },

    async onError(_error: Error, ctx: MiddlewareContext): Promise<void> {
      await finalizeStreamByState(ctx.state);
    },

    async onAbort(_error: Error, ctx: MiddlewareContext): Promise<void> {
      await finalizeStreamByState(ctx.state);
    },

    async onRetry(_attempt: number, _error: Error, ctx: MiddlewareContext): Promise<void> {
      const id = ctx.state.get(STATE_KEY_STREAM_ID) as string | undefined;
      if (!id) {
        return;
      }

      // Wait for in-flight appends to complete before clearing to prevent
      // stale events from repopulating the buffer after clear (especially
      // with async adapters like Redis)
      await waitForAppends(id);

      // Clear pending append chains
      clearAppendState(id);

      // Clear buffered events from adapter so subscribers don't receive duplicates
      await adapter.clear(id);

      // Reset stream ended flag for new attempt
      ctx.state.delete(STATE_KEY_STREAM_ENDED);
    },
  };
}
