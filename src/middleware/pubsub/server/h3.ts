/**
 * @fileoverview H3/Nitro/Nuxt adapter for pub-sub stream resumption.
 *
 * Provides utilities for H3-based servers (Nuxt, Nitro, or standalone H3)
 * to handle stream reconnections.
 *
 * @module middleware/pubsub/server/h3
 */

import type { PubSubAdapter } from '../types.ts';
import { runSubscriberStream } from './shared.ts';

/**
 * Creates a ReadableStream that replays buffered events and subscribes to live events.
 *
 * Use with H3's `sendStream` for proper chunked streaming that works
 * correctly in production (Nitro builds, reverse proxies, compression):
 *
 * ```typescript
 * import { sendStream } from 'h3';
 * return sendStream(event, h3.createSubscriberSSEStream(streamId, adapter));
 * ```
 *
 * @param streamId - The stream ID to subscribe to
 * @param adapter - The pub-sub adapter instance
 * @returns A ReadableStream of SSE-formatted data
 *
 * @example
 * ```typescript
 * import { sendStream } from 'h3';
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
 *   if (!await adapter.exists(conversationId)) {
 *     const model = llm({
 *       model: anthropic('claude-sonnet-4-20250514'),
 *       middleware: [pubsubMiddleware({ adapter, streamId: conversationId })],
 *     });
 *     model.stream(input).then(turn => saveToDatabase(conversationId, turn));
 *   }
 *
 *   return sendStream(event, h3.createSubscriberSSEStream(conversationId, adapter));
 * });
 * ```
 */
export function createSubscriberSSEStream(
  streamId: string,
  adapter: PubSubAdapter,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;

  return new ReadableStream({
    async start(controller) {
      await runSubscriberStream(
        streamId,
        adapter,
        {
          write: (data: string) => {
            if (closed) {
              return;
            }
            controller.enqueue(encoder.encode(data));
          },
          end: () => {
            if (closed) {
              return;
            }
            closed = true;
            try {
              controller.close();
            } catch {
              // Ignore close errors after cancellation
            }
          },
        },
        { signal: abortController.signal }
      );
    },
    cancel() {
      abortController.abort();
    },
  });
}

/**
 * H3 adapter namespace for pub-sub server utilities.
 */
export const h3 = {
  createSubscriberSSEStream,
};
