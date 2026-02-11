import type { StreamResult } from '../../src/types/stream.ts';
import { StreamEventType } from '../../src/types/stream.ts';
import type { Turn } from '../../src/types/turn.ts';
import type { Tool } from '../../src/types/tool.ts';

/**
 * Resolves a model env variable with fallback.
 */
export function envModel(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Collects stream text and returns the final turn.
 */
export async function collectTextStream(stream: StreamResult): Promise<{
  text: string;
  eventCount: number;
  retryEvents: number;
  turn: Turn;
}> {
  let text = '';
  let eventCount = 0;
  let retryEvents = 0;

  for await (const event of stream) {
    eventCount += 1;
    if (event.type === StreamEventType.TextDelta && event.delta.text) {
      text += event.delta.text;
    }
    if (event.type === StreamEventType.StreamRetry) {
      retryEvents += 1;
    }
  }

  const turn = await stream.turn;
  return {
    text,
    eventCount,
    retryEvents,
    turn,
  };
}

/**
 * Creates a deterministic math tool for live and unit tests.
 */
export function createAddTool(): Tool<{ a: number; b: number }, { sum: number }> {
  return {
    name: 'add',
    description: 'Adds two numbers.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
    run: async (params: { a: number; b: number }) => ({
      sum: params.a + params.b,
    }),
  };
}
