/**
 * @fileoverview Pipeline middleware for post-turn processing stages.
 *
 * Enables running async tasks (image generation, embedding, slug generation, etc.)
 * after the LLM completes, while streaming progress events to connected clients.
 *
 * @module middleware/pipeline
 */

import type { Middleware, MiddlewareContext } from '../../types/middleware.ts';
import type { Turn } from '../../types/turn.ts';
import type { StreamEvent, EventDelta } from '../../types/stream.ts';

/**
 * Pipeline stage event delta with stage-specific data.
 */
export interface PipelineStageDelta extends EventDelta {
  /** Stage identifier */
  stage: string;
  /** Stage output payload */
  payload: unknown;
}

/**
 * Stream event for pipeline stage progress.
 * Extends StreamEvent with pipeline-specific delta containing stage and payload.
 */
export interface PipelineStageEvent extends StreamEvent {
  type: 'pipeline_stage';
  delta: PipelineStageDelta;
}

/**
 * Creates a pipeline stage stream event.
 *
 * @param stage - The stage identifier
 * @param payload - The stage output payload
 * @returns A pipeline stage event
 */
export function pipelineStageEvent(stage: string, payload: unknown): PipelineStageEvent {
  return {
    type: 'pipeline_stage',
    index: 0,
    delta: { stage, payload },
  };
}

/**
 * Type guard for PipelineStageEvent.
 *
 * @param event - Stream event to check
 * @returns True if the event is a PipelineStageEvent
 *
 * @example
 * ```typescript
 * for await (const event of stream) {
 *   if (isPipelineStageEvent(event)) {
 *     console.log(event.delta.stage, event.delta.payload);
 *   }
 * }
 * ```
 */
export function isPipelineStageEvent(event: StreamEvent): event is PipelineStageEvent {
  return event.type === 'pipeline_stage';
}

/**
 * Emit function provided to pipeline stages.
 */
export type PipelineEmit = (data: unknown) => void;

/**
 * A single pipeline stage that runs after turn completion.
 *
 * Stages can mutate the turn object to attach computed properties (like slugs,
 * image URLs, etc.) that will be available in the `.then()` callback. Use a
 * type assertion to add properties:
 *
 * @example
 * ```typescript
 * // Define extended turn type
 * interface ExtendedTurn { slug?: string; imageUrl?: string; }
 *
 * // In stage run function
 * run: (turn, emit) => {
 *   const slug = generateSlug(turn.data!.title);
 *   (turn as Turn<TData> & ExtendedTurn).slug = slug;
 *   emit({ slug });
 * }
 *
 * // Access in .then() callback
 * model.stream(prompt).then(turn => {
 *   const extended = turn as typeof turn & ExtendedTurn;
 *   console.log(extended.slug); // Available!
 * });
 * ```
 *
 * @typeParam TData - Type of the turn's structured data
 */
export interface PipelineStage<TData = unknown> {
  /** Unique identifier for this stage (used in events) */
  type: string;

  /**
   * Execute this stage.
   *
   * @param turn - The completed turn (can mutate via type assertion to add properties)
   * @param emit - Function to emit progress events to subscribers
   */
  run: (turn: Turn<TData>, emit: PipelineEmit) => Promise<void> | void;
}

/**
 * Stage error details passed to onStageError callback.
 */
export interface PipelineStageError<TData = unknown> {
  /** The stage that failed */
  stage: PipelineStage<TData>;
  /** The error that occurred */
  error: Error;
  /** The turn being processed */
  turn: Turn<TData>;
}

/**
 * Pipeline middleware configuration.
 *
 * @typeParam TData - Type of the turn's structured data
 */
export interface PipelineConfig<TData = unknown> {
  /** Stages to run after turn completion, executed in order */
  stages: PipelineStage<TData>[];

  /** Run stages in parallel instead of sequential (default: false) */
  parallel?: boolean;

  /**
   * Continue running subsequent stages even if one fails (default: false).
   * In parallel mode, all stages run regardless; this only affects error propagation.
   */
  continueOnError?: boolean;

  /**
   * Called when a stage throws an error.
   * Useful for logging or cleanup. Does not prevent error propagation unless continueOnError is true.
   */
  onStageError?: (details: PipelineStageError<TData>) => void | Promise<void>;
}

/**
 * Creates pipeline middleware for post-turn processing stages.
 *
 * Pipeline middleware enables running async tasks (image generation, embedding,
 * slug generation, etc.) after the LLM completes, while streaming progress
 * events to connected clients.
 *
 * Events are emitted through the standard middleware pipeline via `ctx.emit()`,
 * so any middleware with `onStreamEvent` (like pubsub) will receive them.
 *
 * **Middleware Order**: Place pipeline AFTER pubsub in the array so that:
 * - `onStart`: pubsub runs first (sets up adapter)
 * - `onTurn`: pipeline runs first (emits events), pubsub runs second (cleans up)
 *
 * @typeParam TData - Type of the turn's structured data
 * @param config - Pipeline middleware configuration
 * @returns A middleware instance
 *
 * @example
 * ```typescript
 * import { llm } from '@providerprotocol/ai';
 * import { openai } from '@providerprotocol/ai/openai';
 * import { pubsubMiddleware, memoryAdapter } from '@providerprotocol/ai/middleware/pubsub';
 * import { pipelineMiddleware } from '@providerprotocol/ai/middleware/pipeline';
 *
 * const adapter = memoryAdapter();
 *
 * const model = llm({
 *   model: openai('gpt-4o'),
 *   structure: BlogPostSchema,
 *   middleware: [
 *     pubsubMiddleware({ adapter, streamId: postId }),
 *     pipelineMiddleware<BlogPost>({
 *       stages: [
 *         {
 *           type: 'slug',
 *           run: async (turn, emit) => {
 *             const slug = await generateSlug(turn.data!.title);
 *             (turn as { slug?: string }).slug = slug;
 *             emit({ slug });
 *           },
 *         },
 *         {
 *           type: 'embedding',
 *           run: async (turn, emit) => {
 *             await vectorize(turn.data!);
 *             emit({ embedded: true });
 *           },
 *         },
 *       ],
 *     }),
 *   ],
 * });
 *
 * model.stream(prompt).then(turn => {
 *   const extended = turn as typeof turn & { slug?: string };
 *   await db.posts.update({ _id: id }, {
 *     ...turn.data,
 *     slug: extended.slug,
 *   });
 * });
 * ```
 */
export function pipelineMiddleware<TData = unknown>(config: PipelineConfig<TData>): Middleware {
  const { stages, parallel = false, continueOnError = false, onStageError } = config;

  const runStage = async (
    stage: PipelineStage<TData>,
    typedTurn: Turn<TData>,
    emit: PipelineEmit
  ): Promise<void> => {
    try {
      await stage.run(typedTurn, emit);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (onStageError) {
        await onStageError({ stage, error, turn: typedTurn });
      }
      if (!continueOnError) {
        throw error;
      }
    }
  };

  return {
    name: 'pipeline',

    async onTurn(turn: Turn, ctx: MiddlewareContext): Promise<void> {
      const createEmit = (stageType: string): PipelineEmit => {
        return (data: unknown) => {
          ctx.emit(pipelineStageEvent(stageType, data));
        };
      };

      const typedTurn = turn as Turn<TData>;

      if (parallel) {
        const results = await Promise.allSettled(
          stages.map((stage) => runStage(stage, typedTurn, createEmit(stage.type)))
        );
        // If not continuing on error, throw first rejection
        if (!continueOnError) {
          const firstRejection = results.find(
            (r): r is PromiseRejectedResult => r.status === 'rejected'
          );
          if (firstRejection) {
            throw firstRejection.reason;
          }
        }
      } else {
        for (const stage of stages) {
          await runStage(stage, typedTurn, createEmit(stage.type));
        }
      }
    },
  };
}
