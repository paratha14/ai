import { test, expect, describe } from 'bun:test';
import { llm } from '../../src/index.ts';
import { anthropic } from '../../src/anthropic/index.ts';
import { pubsubMiddleware, memoryAdapter } from '../../src/middleware/pubsub/index.ts';
import { pipelineMiddleware, type PipelineStageEvent } from '../../src/middleware/pipeline/index.ts';
import { createSubscriberStream } from '../../src/middleware/pubsub/server/webapi.ts';
import { parseSSEStream } from '../../src/http/sse.ts';
import { deserializeStreamEvent } from '../../src/stream/serialization.ts';
import type { StreamEvent } from '../../src/types/stream.ts';
import { z } from 'zod';

const BlogPostSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  summary: z.string(),
});

type BlogPost = z.infer<typeof BlogPostSchema>;

interface ExtendedTurn {
  slug?: string;
  processed?: boolean;
}

const isStreamEventPayload = (payload: unknown): payload is StreamEvent => {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as { type?: unknown; index?: unknown; delta?: unknown };
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.index === 'number' &&
    candidate.delta !== null &&
    typeof candidate.delta === 'object'
  );
};

const collectPipelineEvents = async (
  stream: ReadableStream<Uint8Array>
): Promise<PipelineStageEvent[]> => {
  const pipelineEvents: PipelineStageEvent[] = [];
  for await (const payload of parseSSEStream(stream)) {
    if (!isStreamEventPayload(payload)) continue;
    const event = deserializeStreamEvent(payload);
    if (event.type === 'pipeline_stage') {
      pipelineEvents.push(event as PipelineStageEvent);
    }
  }
  return pipelineEvents;
};

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Pipeline middleware (live)', () => {
  test('pipeline stages run after streaming completes and emit events', async () => {
    const adapter = memoryAdapter();
    const streamId = `pipeline-${crypto.randomUUID()}`;
    const stageExecutionOrder: string[] = [];

    const model = llm({
      model: anthropic('claude-3-5-haiku-latest'),
      params: { max_tokens: 256 },
      structure: BlogPostSchema,
      middleware: [
        pubsubMiddleware({ adapter, streamId }),
        pipelineMiddleware<BlogPost>({
          stages: [
            {
              type: 'slug',
              run: (turn, emit) => {
                stageExecutionOrder.push('slug');
                const slug = turn.data!.title.toLowerCase().replace(/\s+/g, '-');
                (turn as unknown as ExtendedTurn).slug = slug;
                emit({ slug });
              },
            },
            {
              type: 'process',
              run: async (turn, emit) => {
                stageExecutionOrder.push('process');
                await new Promise((r) => setTimeout(r, 10));
                (turn as unknown as ExtendedTurn).processed = true;
                emit({ processed: true, tagCount: turn.data!.tags.length });
              },
            },
          ],
        }),
      ],
    });

    const subscriberPromise = collectPipelineEvents(createSubscriberStream(streamId, adapter));

    const turn = await model.stream('Generate a blog post about TypeScript generics.');
    const pipelineEvents = await subscriberPromise;

    // Verify turn data exists
    expect(turn.data).toBeDefined();
    const data = turn.data as BlogPost;
    expect(data.title).toBeDefined();
    expect(data.tags.length).toBeGreaterThan(0);

    // Verify stages ran in order
    expect(stageExecutionOrder).toEqual(['slug', 'process']);

    // Verify turn was mutated
    const extended = turn as typeof turn & ExtendedTurn;
    expect(extended.slug).toBeDefined();
    expect(extended.slug).toBe(data.title.toLowerCase().replace(/\s+/g, '-'));
    expect(extended.processed).toBe(true);

    // Verify pipeline events were emitted and received by subscriber
    expect(pipelineEvents.length).toBe(2);

    const slugEvent = pipelineEvents.find((e) => e.delta.stage === 'slug');
    expect(slugEvent).toBeDefined();
    expect((slugEvent!.delta.payload as { slug: string }).slug).toBe(extended.slug!);

    const processEvent = pipelineEvents.find((e) => e.delta.stage === 'process');
    expect(processEvent).toBeDefined();
    expect((processEvent!.delta.payload as { processed: boolean }).processed).toBe(true);
  });

  test(
    'pipeline stages work with .generate() (non-streaming)',
    async () => {
      const stageExecutionOrder: string[] = [];

      const model = llm({
        model: anthropic('claude-3-5-haiku-latest'),
        params: { max_tokens: 256 },
        structure: BlogPostSchema,
        middleware: [
          pipelineMiddleware<BlogPost>({
            stages: [
              {
                type: 'slug',
                run: (turn, emit) => {
                  stageExecutionOrder.push('slug');
                  const slug = turn.data!.title.toLowerCase().replace(/\s+/g, '-');
                  (turn as unknown as ExtendedTurn).slug = slug;
                  emit({ slug }); // emit works but no subscriber in non-streaming
                },
              },
            ],
          }),
        ],
      });

      const turn = await model.generate('Generate a blog post about async/await in JavaScript.');

      // Verify turn data exists
      expect(turn.data).toBeDefined();
      const data = turn.data as BlogPost;
      expect(data.title).toBeDefined();

      // Verify stages ran
      expect(stageExecutionOrder).toEqual(['slug']);

      // Verify turn was mutated
      const extended = turn as typeof turn & ExtendedTurn;
      expect(extended.slug).toBeDefined();
    },
    { timeout: 30000 }
  );

  test('pipeline stages run in parallel when configured', async () => {
    const adapter = memoryAdapter();
    const streamId = `pipeline-parallel-${crypto.randomUUID()}`;
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const model = llm({
      model: anthropic('claude-3-5-haiku-latest'),
      params: { max_tokens: 128 },
      structure: BlogPostSchema,
      middleware: [
        pubsubMiddleware({ adapter, streamId }),
        pipelineMiddleware<BlogPost>({
          parallel: true,
          stages: [
            {
              type: 'slow',
              run: async (_turn, emit) => {
                startTimes.slow = Date.now();
                await new Promise((r) => setTimeout(r, 100));
                endTimes.slow = Date.now();
                emit({ slow: true });
              },
            },
            {
              type: 'fast',
              run: async (_turn, emit) => {
                startTimes.fast = Date.now();
                await new Promise((r) => setTimeout(r, 20));
                endTimes.fast = Date.now();
                emit({ fast: true });
              },
            },
          ],
        }),
      ],
    });

    const subscriberPromise = collectPipelineEvents(createSubscriberStream(streamId, adapter));

    const startTime = Date.now();
    await model.stream('Generate a short blog post about coding.');
    const totalTime = Date.now() - startTime;
    const pipelineEvents = await subscriberPromise;

    // Both stages should have started at roughly the same time
    expect(Math.abs(startTimes.slow! - startTimes.fast!)).toBeLessThan(50);

    // Both events should have been emitted
    expect(pipelineEvents.length).toBe(2);
    expect(pipelineEvents.some((e) => e.delta.stage === 'slow')).toBe(true);
    expect(pipelineEvents.some((e) => e.delta.stage === 'fast')).toBe(true);
  });

  test('pipeline middleware works without pubsub', async () => {
    const stageRan = { value: false };

    const model = llm({
      model: anthropic('claude-3-5-haiku-latest'),
      params: { max_tokens: 128 },
      middleware: [
        pipelineMiddleware({
          stages: [
            {
              type: 'standalone',
              run: (turn, emit) => {
                stageRan.value = true;
                // emit still works (no-op without pubsub subscriber)
                emit({ standalone: true });
                (turn as unknown as { marker: string }).marker = 'was-here';
              },
            },
          ],
        }),
      ],
    });

    const turn = await model.stream('Say hello.');

    expect(stageRan.value).toBe(true);
    expect((turn as unknown as { marker: string }).marker).toBe('was-here');
  });
});
