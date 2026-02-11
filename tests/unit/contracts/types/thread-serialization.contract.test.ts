import { describe, expect, test } from 'bun:test';
import { AssistantMessage, ToolResultMessage, UserMessage } from '../../../../src/types/messages.ts';
import { Thread, type ThreadJSON } from '../../../../src/types/thread.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';

describe('Thread serialization contracts', () => {
  test('preserves message identity and metadata across JSON round-trips', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const thread = new Thread([
      new UserMessage('Find weather for NYC.', {
        id: 'u-1',
        timestamp,
        metadata: { test: { traceId: 'trace-1' } },
      }),
      new AssistantMessage(
        [{ type: 'text', text: 'Calling tool now.' }],
        [{
          toolCallId: 'tool-1',
          toolName: 'get_weather',
          arguments: { city: 'NYC' },
        }],
        {
          id: 'a-1',
          timestamp,
          metadata: { test: { traceId: 'trace-2' } },
        },
      ),
      new ToolResultMessage([
        {
          toolCallId: 'tool-1',
          result: { temperature: 72 },
        },
      ], {
        id: 't-1',
        timestamp,
      }),
    ]);

    const json = thread.toJSON();
    const restored = Thread.fromJSON(json);

    expect(restored.id).toBe(thread.id);
    expect(restored.toJSON()).toEqual(json);
    expect(restored.messages[1]?.type).toBe('assistant');
    expect((restored.messages[1] as AssistantMessage).toolCalls?.[0]?.toolName).toBe('get_weather');
  });

  test('append adds turn messages in chronological order', () => {
    const thread = new Thread([new UserMessage('Q1')]);
    const turn = createTurn(
      [new UserMessage('Q2'), new AssistantMessage('A2')],
      [],
      emptyUsage(),
      1,
    );

    thread.append(turn);

    expect(thread.messages.map((message) => message.text)).toEqual(['Q1', 'Q2', 'A2']);
    expect(thread.tail(2).map((message) => message.text)).toEqual(['Q2', 'A2']);
  });

  test('fromJSON rejects unknown message types', () => {
    const validThread = new Thread([new UserMessage('hello')]);
    const validJson = validThread.toJSON();

    const invalidJson = {
      ...validJson,
      messages: [{
        ...validJson.messages[0],
        type: 'invalid_type',
      }],
    } as unknown as ThreadJSON;

    expect(() => Thread.fromJSON(invalidJson)).toThrow('Unknown message type');
  });
});
