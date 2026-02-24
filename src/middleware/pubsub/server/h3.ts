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
 * Options for subscriber SSE streams.
 */
export interface SubscriberSSEStreamOptions {
  /**
   * Interval in milliseconds between SSE keepalive comments.
   * Set to `0` to disable. Defaults to `5000` (5 seconds).
   */
  keepaliveMs?: number;
}

/**
 * Creates a ReadableStream that replays buffered events and subscribes to live events.
 *
 * Returns a `ReadableStream<Uint8Array>` for use with H3's `sendStream`.
 *
 * **Important:** H3's `sendStream` does **not** set response headers. You must
 * set SSE headers yourself before calling `sendStream`, otherwise reverse proxies
 * and CDNs (e.g. Cloudflare) won't recognise the response as an event stream
 * and may buffer or timeout the connection.
 *
 * Keepalive comments (`:keepalive\n\n`) are sent automatically at a default
 * interval of 5 seconds to prevent idle timeouts during long-running operations
 * like pipeline stages. This can be configured via the `options` parameter.
 *
 * @param streamId - The stream ID to subscribe to
 * @param adapter - The pub-sub adapter instance
 * @param options - Optional stream configuration
 * @returns A ReadableStream of SSE-formatted data
 *
 * @example
 * ```typescript
 * import { sendStream, setHeader } from 'h3';
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
 *   // Required: H3's sendStream does NOT set these headers
 *   setHeader(event, 'Content-Type', 'text/event-stream');
 *   setHeader(event, 'Cache-Control', 'no-cache');
 *   setHeader(event, 'Connection', 'keep-alive');
 *   setHeader(event, 'X-Accel-Buffering', 'no');
 *
 *   return sendStream(event, h3.createSubscriberSSEStream(conversationId, adapter));
 * });
 * ```
 */
export function createSubscriberSSEStream(
  streamId: string,
  adapter: PubSubAdapter,
  options: SubscriberSSEStreamOptions = {},
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
        {
          signal: abortController.signal,
          keepaliveMs: options.keepaliveMs,
        }
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
