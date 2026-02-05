import { test, expect, describe } from 'bun:test';
import {
  StreamEventType,
  textDelta,
  toolCallDelta,
  objectDelta,
  messageStart,
  messageStop,
  contentBlockStart,
  contentBlockStop,
  toolExecutionStart,
  toolExecutionEnd,
  streamRetry,
} from '../../../src/types/stream.ts';

describe('Stream event creators', () => {
  describe('textDelta', () => {
    test('creates text delta event', () => {
      const event = textDelta('Hello');
      expect(event.type).toBe(StreamEventType.TextDelta);
      expect(event.index).toBe(0);
      expect(event.delta.text).toBe('Hello');
    });

    test('accepts custom index', () => {
      const event = textDelta('World', 2);
      expect(event.index).toBe(2);
    });
  });

  describe('toolCallDelta', () => {
    test('creates tool call delta event', () => {
      const event = toolCallDelta('call_123', 'getWeather', '{"city":"Tokyo"}');
      expect(event.type).toBe(StreamEventType.ToolCallDelta);
      expect(event.index).toBe(0);
      expect(event.delta.toolCallId).toBe('call_123');
      expect(event.delta.toolName).toBe('getWeather');
      expect(event.delta.argumentsJson).toBe('{"city":"Tokyo"}');
    });

    test('accepts custom index', () => {
      const event = toolCallDelta('call_456', 'calculate', '{}', 3);
      expect(event.index).toBe(3);
    });

    test('contains argumentsJson for incremental parsing', () => {
      const event = toolCallDelta('call_123', 'getWeather', '{"city":"Tok');
      expect(event.delta.argumentsJson).toBe('{"city":"Tok');
    });
  });

  describe('objectDelta', () => {
    test('creates object delta event', () => {
      const event = objectDelta('{"name":');
      expect(event.type).toBe(StreamEventType.ObjectDelta);
      expect(event.index).toBe(0);
      expect(event.delta.text).toBe('{"name":');
    });

    test('accepts custom index', () => {
      const event = objectDelta('hello', 2);
      expect(event.index).toBe(2);
    });

    test('handles incremental JSON text', () => {
      const event = objectDelta('{"user":{"firstName":"Jo","profile":{"age":30}}}');
      expect(event.delta.text).toBe('{"user":{"firstName":"Jo","profile":{"age":30}}}');
    });

    test('handles array text', () => {
      const event = objectDelta('[1,2,3]');
      expect(event.delta.text).toBe('[1,2,3]');
    });
  });

  describe('messageStart', () => {
    test('creates message start event', () => {
      const event = messageStart();
      expect(event.type).toBe(StreamEventType.MessageStart);
      expect(event.index).toBe(0);
      expect(event.delta).toEqual({});
    });
  });

  describe('messageStop', () => {
    test('creates message stop event', () => {
      const event = messageStop();
      expect(event.type).toBe(StreamEventType.MessageStop);
      expect(event.index).toBe(0);
      expect(event.delta).toEqual({});
    });
  });

  describe('contentBlockStart', () => {
    test('creates content block start event', () => {
      const event = contentBlockStart(1);
      expect(event.type).toBe(StreamEventType.ContentBlockStart);
      expect(event.index).toBe(1);
      expect(event.delta).toEqual({});
    });
  });

  describe('contentBlockStop', () => {
    test('creates content block stop event', () => {
      const event = contentBlockStop(2);
      expect(event.type).toBe(StreamEventType.ContentBlockStop);
      expect(event.index).toBe(2);
      expect(event.delta).toEqual({});
    });
  });

  describe('toolExecutionStart', () => {
    test('creates tool execution start event', () => {
      const timestamp = Date.now();
      const event = toolExecutionStart('call_123', 'getWeather', timestamp);

      expect(event.type).toBe(StreamEventType.ToolExecutionStart);
      expect(event.index).toBe(0);
      expect(event.delta.toolCallId).toBe('call_123');
      expect(event.delta.toolName).toBe('getWeather');
      expect(event.delta.timestamp).toBe(timestamp);
    });

    test('accepts custom index', () => {
      const timestamp = Date.now();
      const event = toolExecutionStart('call_456', 'calculate', timestamp, 2);

      expect(event.index).toBe(2);
    });

    test('works with different tool names', () => {
      const timestamp = 1704067200000;
      const event = toolExecutionStart('tc_abc', 'multiply', timestamp);

      expect(event.delta.toolCallId).toBe('tc_abc');
      expect(event.delta.toolName).toBe('multiply');
      expect(event.delta.timestamp).toBe(1704067200000);
    });
  });

  describe('toolExecutionEnd', () => {
    test('creates tool execution end event with success', () => {
      const timestamp = Date.now();
      const event = toolExecutionEnd('call_123', 'getWeather', 'Tokyo: 75°F', false, timestamp);

      expect(event.type).toBe(StreamEventType.ToolExecutionEnd);
      expect(event.index).toBe(0);
      expect(event.delta.toolCallId).toBe('call_123');
      expect(event.delta.toolName).toBe('getWeather');
      expect(event.delta.result).toBe('Tokyo: 75°F');
      expect(event.delta.isError).toBe(false);
      expect(event.delta.timestamp).toBe(timestamp);
    });

    test('creates tool execution end event with error', () => {
      const timestamp = Date.now();
      const event = toolExecutionEnd('call_456', 'calculate', 'Division by zero', true, timestamp);

      expect(event.delta.result).toBe('Division by zero');
      expect(event.delta.isError).toBe(true);
    });

    test('accepts custom index', () => {
      const timestamp = Date.now();
      const event = toolExecutionEnd('call_789', 'search', 'Found 10 results', false, timestamp, 3);

      expect(event.index).toBe(3);
    });

    test('handles object results', () => {
      const timestamp = Date.now();
      const result = { temperature: 75, unit: 'F', conditions: ['sunny', 'clear'] };
      const event = toolExecutionEnd('call_obj', 'getWeather', result, false, timestamp);

      expect(event.delta.result).toEqual(result);
    });

    test('handles null result', () => {
      const timestamp = Date.now();
      const event = toolExecutionEnd('call_null', 'voidFunction', null, false, timestamp);

      expect(event.delta.result).toBeNull();
    });

    test('handles undefined result', () => {
      const timestamp = Date.now();
      const event = toolExecutionEnd('call_undef', 'voidFunction', undefined, false, timestamp);

      expect(event.delta.result).toBeUndefined();
    });
  });

  describe('streamRetry', () => {
    test('creates stream retry event', () => {
      const timestamp = Date.now();
      const error = new Error('Connection timeout');
      const event = streamRetry(1, 3, error, timestamp);

      expect(event.type).toBe(StreamEventType.StreamRetry);
      expect(event.index).toBe(0);
      expect(event.delta.attempt).toBe(1);
      expect(event.delta.maxAttempts).toBe(3);
      expect(event.delta.error?.message).toBe('Connection timeout');
      expect(event.delta.timestamp).toBe(timestamp);
    });

    test('handles different attempt numbers', () => {
      const timestamp = Date.now();
      const error = new Error('Rate limited');
      const event = streamRetry(2, 5, error, timestamp);

      expect(event.delta.attempt).toBe(2);
      expect(event.delta.maxAttempts).toBe(5);
    });

    test('serializes error for JSON transport', () => {
      const timestamp = 1704067200000;
      const error = new Error('API unavailable');
      const event = streamRetry(3, 3, error, timestamp);

      // Error is serialized to a plain object (not Error instance)
      expect(event.delta.error?.message).toBe('API unavailable');
      // JSON.stringify should now work correctly
      const json = JSON.stringify(event);
      const parsed = JSON.parse(json);
      expect(parsed.delta.error.message).toBe('API unavailable');
    });

    test('includes error code when present', () => {
      // Create an error-like object with a code property (like UPPError)
      const error = Object.assign(new Error('Rate limit exceeded'), { code: 'RATE_LIMITED' });
      const timestamp = Date.now();
      const event = streamRetry(1, 3, error, timestamp);

      expect(event.delta.error?.message).toBe('Rate limit exceeded');
      expect(event.delta.error?.code).toBe('RATE_LIMITED');
    });
  });
});
