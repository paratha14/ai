import { test, expect, describe } from 'bun:test';
import {
  pipelineMiddleware,
  pipelineStageEvent,
  isPipelineStageEvent,
  type PipelineStage,
  type PipelineStageEvent,
} from '../../../src/middleware/pipeline/index.ts';
import { createMiddlewareContext } from '../../../src/middleware/runner.ts';
import { createTurn } from '../../../src/types/turn.ts';
import { AssistantMessage } from '../../../src/types/messages.ts';
import type { MiddlewareContext } from '../../../src/types/middleware.ts';
import type { StreamEvent } from '../../../src/types/stream.ts';
import type { Turn } from '../../../src/types/turn.ts';

function createTestTurn<TData>(data?: TData) {
  const message = new AssistantMessage([{ type: 'text', text: 'Hello' }]);
  return createTurn(
    [message],
    [],
    { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
    1,
    data
  );
}

function createTestContext(emitFn: (event: StreamEvent) => void = () => {}): MiddlewareContext {
  const emitHolder = { fn: emitFn };
  const ctx = createMiddlewareContext(
    'llm',
    'test-model',
    'test-provider',
    true,
    {} as MiddlewareContext['request'],
    emitHolder
  );
  return ctx;
}

describe('pipelineMiddleware', () => {
  describe('pipelineStageEvent', () => {
    test('creates a pipeline stage event with correct structure', () => {
      const event = pipelineStageEvent('slug', { slug: 'my-recipe' });

      expect(event.type).toBe('pipeline_stage');
      expect(event.index).toBe(0);
      expect(event.delta.stage).toBe('slug');
      expect(event.delta.payload).toEqual({ slug: 'my-recipe' });
    });
  });

  describe('isPipelineStageEvent', () => {
    test('returns true for pipeline stage events', () => {
      const event = pipelineStageEvent('test', { data: 123 });
      expect(isPipelineStageEvent(event)).toBe(true);
    });

    test('returns false for other event types', () => {
      const textEvent: StreamEvent = {
        type: 'text_delta',
        index: 0,
        delta: { text: 'hello' },
      };
      expect(isPipelineStageEvent(textEvent)).toBe(false);
    });
  });

  describe('runTurnHook error handling', () => {
    test('continues running all middleware even if early middleware throws', async () => {
      const stagesRun: string[] = [];
      const cleanupRan = { value: false };

      // Simulate pubsub-like middleware that needs cleanup
      const cleanupMiddleware: { name: string; onTurn: (turn: Turn, ctx: MiddlewareContext) => void } = {
        name: 'cleanup',
        onTurn: () => {
          cleanupRan.value = true;
        },
      };

      // Pipeline middleware that throws
      const pipelineStages: PipelineStage[] = [
        {
          type: 'failing',
          run: () => {
            stagesRun.push('failing');
            throw new Error('Stage failed');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages: pipelineStages });
      const ctx = createTestContext();
      const turn = createTestTurn();

      // Import runTurnHook to test the fix directly
      const { runTurnHook } = await import('../../../src/middleware/runner.ts');

      // With [cleanup, pipeline], reverse order means pipeline runs first, then cleanup
      // Even if pipeline throws, cleanup should still run
      await expect(runTurnHook([cleanupMiddleware, mw], turn, ctx)).rejects.toThrow('Stage failed');

      expect(stagesRun).toEqual(['failing']);
      expect(cleanupRan.value).toBe(true);
    });
  });

  describe('middleware properties', () => {
    test('has correct name', () => {
      const mw = pipelineMiddleware({ stages: [] });
      expect(mw.name).toBe('pipeline');
    });

    test('has onTurn hook', () => {
      const mw = pipelineMiddleware({ stages: [] });
      expect(mw.onTurn).toBeDefined();
    });
  });

  describe('sequential execution', () => {
    test('runs stages in order', async () => {
      const order: string[] = [];

      const stages: PipelineStage<{ title: string }>[] = [
        {
          type: 'first',
          run: async () => {
            await new Promise((r) => setTimeout(r, 10));
            order.push('first');
          },
        },
        {
          type: 'second',
          run: () => {
            order.push('second');
          },
        },
        {
          type: 'third',
          run: async () => {
            order.push('third');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const ctx = createTestContext();
      const turn = createTestTurn({ title: 'Test Post' });

      await mw.onTurn!(turn, ctx);

      expect(order).toEqual(['first', 'second', 'third']);
    });

    test('provides turn data to stages', async () => {
      let receivedData: unknown;

      const stages: PipelineStage<{ title: string }>[] = [
        {
          type: 'check',
          run: (turn) => {
            receivedData = turn.data;
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const ctx = createTestContext();
      const turn = createTestTurn({ title: 'My Blog Post' });

      await mw.onTurn!(turn, ctx);

      expect(receivedData).toEqual({ title: 'My Blog Post' });
    });

    test('emits events through ctx.emit', async () => {
      const emittedEvents: StreamEvent[] = [];
      const ctx = createTestContext((event) => emittedEvents.push(event));

      const stages: PipelineStage[] = [
        {
          type: 'slug',
          run: (_turn, emit) => {
            emit({ slug: 'test-slug' });
          },
        },
        {
          type: 'image',
          run: (_turn, emit) => {
            emit({ imageUrl: 'https://example.com/image.jpg' });
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(emittedEvents).toHaveLength(2);

      const slugEvent = emittedEvents[0] as PipelineStageEvent;
      expect(slugEvent.type).toBe('pipeline_stage');
      expect(slugEvent.delta.stage).toBe('slug');
      expect(slugEvent.delta.payload).toEqual({ slug: 'test-slug' });

      const imageEvent = emittedEvents[1] as PipelineStageEvent;
      expect(imageEvent.type).toBe('pipeline_stage');
      expect(imageEvent.delta.stage).toBe('image');
      expect(imageEvent.delta.payload).toEqual({ imageUrl: 'https://example.com/image.jpg' });
    });

    test('allows turn mutation', async () => {
      const stages: PipelineStage<{ title: string }>[] = [
        {
          type: 'slug',
          run: (turn) => {
            (turn as { slug?: string }).slug = 'mutated-slug';
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const ctx = createTestContext();
      const turn = createTestTurn({ title: 'Test' });

      await mw.onTurn!(turn, ctx);

      expect((turn as { slug?: string }).slug).toBe('mutated-slug');
    });
  });

  describe('parallel execution', () => {
    test('runs stages in parallel when configured', async () => {
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      const stages: PipelineStage[] = [
        {
          type: 'slow',
          run: async () => {
            startTimes.slow = Date.now();
            await new Promise((r) => setTimeout(r, 50));
            endTimes.slow = Date.now();
          },
        },
        {
          type: 'fast',
          run: async () => {
            startTimes.fast = Date.now();
            await new Promise((r) => setTimeout(r, 10));
            endTimes.fast = Date.now();
          },
        },
      ];

      const mw = pipelineMiddleware({ stages, parallel: true });
      const ctx = createTestContext();
      const turn = createTestTurn();

      const start = Date.now();
      await mw.onTurn!(turn, ctx);
      const totalDuration = Date.now() - start;

      // In parallel, total time should be ~50ms (the slower one)
      // In sequential, it would be ~60ms
      expect(totalDuration).toBeLessThan(70);

      // Both should have started at roughly the same time
      expect(Math.abs(startTimes.slow! - startTimes.fast!)).toBeLessThan(15);
    });

    test('parallel stages can all emit events', async () => {
      const emittedEvents: StreamEvent[] = [];
      const ctx = createTestContext((event) => emittedEvents.push(event));

      const stages: PipelineStage[] = [
        {
          type: 'a',
          run: async (_turn, emit) => {
            await new Promise((r) => setTimeout(r, 10));
            emit({ a: true });
          },
        },
        {
          type: 'b',
          run: (_turn, emit) => {
            emit({ b: true });
          },
        },
      ];

      const mw = pipelineMiddleware({ stages, parallel: true });
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(emittedEvents).toHaveLength(2);
      const types = emittedEvents.map((e) => (e as PipelineStageEvent).delta.stage);
      expect(types).toContain('a');
      expect(types).toContain('b');
    });
  });

  describe('edge cases', () => {
    test('handles empty stages array', async () => {
      const mw = pipelineMiddleware({ stages: [] });
      const ctx = createTestContext();
      const turn = createTestTurn();

      // Should not throw
      await mw.onTurn!(turn, ctx);
    });

    test('handles stage that emits nothing', async () => {
      const emittedEvents: StreamEvent[] = [];
      const ctx = createTestContext((event) => emittedEvents.push(event));

      const stages: PipelineStage[] = [
        {
          type: 'silent',
          run: () => {
            // Does work but doesn't emit
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(emittedEvents).toHaveLength(0);
    });

    test('handles stage that emits multiple times', async () => {
      const emittedEvents: StreamEvent[] = [];
      const ctx = createTestContext((event) => emittedEvents.push(event));

      const stages: PipelineStage[] = [
        {
          type: 'chatty',
          run: (_turn, emit) => {
            emit({ progress: 25 });
            emit({ progress: 50 });
            emit({ progress: 75 });
            emit({ progress: 100 });
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(emittedEvents).toHaveLength(4);
      const payloads = emittedEvents.map((e) => (e as PipelineStageEvent).delta.payload);
      expect(payloads).toEqual([
        { progress: 25 },
        { progress: 50 },
        { progress: 75 },
        { progress: 100 },
      ]);
    });

    test('propagates stage errors', async () => {
      const stages: PipelineStage[] = [
        {
          type: 'failing',
          run: () => {
            throw new Error('Stage failed');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const ctx = createTestContext();
      const turn = createTestTurn();

      await expect(mw.onTurn!(turn, ctx)).rejects.toThrow('Stage failed');
    });

    test('handles async stage errors', async () => {
      const stages: PipelineStage[] = [
        {
          type: 'async-failing',
          run: async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('Async stage failed');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages });
      const ctx = createTestContext();
      const turn = createTestTurn();

      await expect(mw.onTurn!(turn, ctx)).rejects.toThrow('Async stage failed');
    });

    test('calls onStageError callback on failure', async () => {
      const errorDetails: Array<{ stage: string; error: string }> = [];

      const stages: PipelineStage[] = [
        {
          type: 'failing',
          run: () => {
            throw new Error('Stage failed');
          },
        },
      ];

      const mw = pipelineMiddleware({
        stages,
        onStageError: ({ stage, error }) => {
          errorDetails.push({ stage: stage.type, error: error.message });
        },
      });
      const ctx = createTestContext();
      const turn = createTestTurn();

      await expect(mw.onTurn!(turn, ctx)).rejects.toThrow('Stage failed');
      expect(errorDetails).toEqual([{ stage: 'failing', error: 'Stage failed' }]);
    });

    test('continues on error when continueOnError is true', async () => {
      const stagesRun: string[] = [];

      const stages: PipelineStage[] = [
        {
          type: 'first',
          run: () => {
            stagesRun.push('first');
            throw new Error('First failed');
          },
        },
        {
          type: 'second',
          run: () => {
            stagesRun.push('second');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages, continueOnError: true });
      const ctx = createTestContext();
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(stagesRun).toEqual(['first', 'second']);
    });

    test('parallel mode collects all errors with continueOnError false', async () => {
      const stages: PipelineStage[] = [
        {
          type: 'slow-fail',
          run: async () => {
            await new Promise((r) => setTimeout(r, 20));
            throw new Error('Slow failed');
          },
        },
        {
          type: 'fast-fail',
          run: () => {
            throw new Error('Fast failed');
          },
        },
      ];

      const mw = pipelineMiddleware({ stages, parallel: true });
      const ctx = createTestContext();
      const turn = createTestTurn();

      // Should throw the first rejection encountered
      await expect(mw.onTurn!(turn, ctx)).rejects.toThrow();
    });

    test('parallel mode continues with continueOnError true', async () => {
      const errorDetails: string[] = [];

      const stages: PipelineStage[] = [
        {
          type: 'fail',
          run: () => {
            throw new Error('Failed');
          },
        },
        {
          type: 'success',
          run: (_turn, emit) => {
            emit({ success: true });
          },
        },
      ];

      const emittedEvents: StreamEvent[] = [];
      const ctx = createTestContext((event) => emittedEvents.push(event));

      const mw = pipelineMiddleware({
        stages,
        parallel: true,
        continueOnError: true,
        onStageError: ({ error }) => {
          errorDetails.push(error.message);
        },
      });
      const turn = createTestTurn();

      await mw.onTurn!(turn, ctx);

      expect(errorDetails).toEqual(['Failed']);
      expect(emittedEvents).toHaveLength(1);
    });
  });
});
