import { describe, expect, test } from 'bun:test';
import {
  AssistantMessage,
  MessageRole,
  ToolResultMessage,
  UserMessage,
  isAssistantMessage,
  isToolResultMessage,
  isUserMessage,
} from '../../../../src/types/messages.ts';
import { ErrorCode, ModalityType, UPPError } from '../../../../src/types/errors.ts';
import {
  StreamEventType,
  contentBlockStart,
  contentBlockStop,
  messageStart,
  messageStop,
  objectDelta,
  streamRetry,
  textDelta,
  toolCallDelta,
  toolExecutionEnd,
  toolExecutionStart,
} from '../../../../src/types/stream.ts';

describe('Message and stream factory contracts', () => {
  test('message constructors normalize inputs and preserve role/type guard behavior', () => {
    const user = new UserMessage('Hello');
    const assistant = new AssistantMessage('Calling tool', [
      {
        toolCallId: 'call-1',
        toolName: 'sum',
        arguments: { a: 1, b: 2 },
      },
    ]);
    const toolResult = new ToolResultMessage([
      {
        toolCallId: 'call-1',
        result: { value: 3 },
      },
    ]);

    expect(user.type).toBe(MessageRole.User);
    expect(user.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(assistant.type).toBe(MessageRole.Assistant);
    expect(assistant.hasToolCalls).toBe(true);
    expect(toolResult.type).toBe(MessageRole.ToolResult);
    expect(toolResult.text).toBe('{"value":3}');

    expect(isUserMessage(user)).toBe(true);
    expect(isAssistantMessage(assistant)).toBe(true);
    expect(isToolResultMessage(toolResult)).toBe(true);
  });

  test('stream event factories produce stable typed payload shapes', () => {
    const timestamp = 1735689600000;

    const started = messageStart();
    const text = textDelta('chunk', 2);
    const toolCall = toolCallDelta('call-1', 'sum', '{"a":1}', 2);
    const object = objectDelta('{"value":', 2);
    const blockStart = contentBlockStart(2);
    const executionStart = toolExecutionStart('call-1', 'sum', timestamp, 2);
    const executionEnd = toolExecutionEnd('call-1', 'sum', { value: 3 }, false, timestamp + 10, 2);
    const blockStop = contentBlockStop(2);
    const stopped = messageStop();

    expect([
      started.type,
      text.type,
      toolCall.type,
      object.type,
      blockStart.type,
      executionStart.type,
      executionEnd.type,
      blockStop.type,
      stopped.type,
    ]).toEqual([
      StreamEventType.MessageStart,
      StreamEventType.TextDelta,
      StreamEventType.ToolCallDelta,
      StreamEventType.ObjectDelta,
      StreamEventType.ContentBlockStart,
      StreamEventType.ToolExecutionStart,
      StreamEventType.ToolExecutionEnd,
      StreamEventType.ContentBlockStop,
      StreamEventType.MessageStop,
    ]);

    expect(toolCall).toEqual({
      type: StreamEventType.ToolCallDelta,
      index: 2,
      delta: {
        toolCallId: 'call-1',
        toolName: 'sum',
        argumentsJson: '{"a":1}',
      },
    });
    expect(executionStart.delta).toEqual({
      toolCallId: 'call-1',
      toolName: 'sum',
      timestamp,
    });
    expect(executionEnd.delta).toEqual({
      toolCallId: 'call-1',
      toolName: 'sum',
      result: { value: 3 },
      isError: false,
      timestamp: timestamp + 10,
    });
  });

  test('streamRetry serializes error details for transport', () => {
    const error = new UPPError(
      'rate limited',
      ErrorCode.RateLimited,
      'mock',
      ModalityType.LLM,
    );
    const retryEvent = streamRetry(2, 5, error, 1735689600010);

    expect(retryEvent).toEqual({
      type: StreamEventType.StreamRetry,
      index: 0,
      delta: {
        attempt: 2,
        maxAttempts: 5,
        error: {
          message: 'rate limited',
          code: ErrorCode.RateLimited,
        },
        timestamp: 1735689600010,
      },
    });

    expect(JSON.parse(JSON.stringify(retryEvent))).toEqual({
      type: StreamEventType.StreamRetry,
      index: 0,
      delta: {
        attempt: 2,
        maxAttempts: 5,
        error: {
          message: 'rate limited',
          code: ErrorCode.RateLimited,
        },
        timestamp: 1735689600010,
      },
    });
  });
});
