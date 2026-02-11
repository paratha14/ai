import { describe, expect, test } from 'bun:test';
import {
  loggingMiddleware,
  type LogLevel,
} from '../../../../src/middleware/logging.ts';
import { createMiddlewareContext, createStreamContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { textDelta } from '../../../../src/types/stream.ts';
import type { Tool } from '../../../../src/types/tool.ts';

interface CapturedLog {
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

function createLLMRequest(): LLMRequest {
  return {
    messages: [],
    config: {} as LLMRequest['config'],
  };
}

describe('Logging middleware contracts', () => {
  test('logs lifecycle start/model/end with configured prefix', () => {
    const logs: CapturedLog[] = [];
    const middleware = loggingMiddleware({
      level: 'debug',
      prefix: '[TEST]',
      logger: (level, message, data) => {
        logs.push({ level, message, data });
      },
    });

    const context = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      true,
      createLLMRequest(),
    );

    middleware.onStart?.(context);
    context.endTime = context.startTime + 25;
    middleware.onEnd?.(context);

    expect(logs.some((entry) => (
      entry.level === 'info'
      && entry.message === '[TEST] [mock-provider] Starting llm request (streaming)'
    ))).toBe(true);
    expect(logs.some((entry) => (
      entry.level === 'debug'
      && entry.message === '[TEST] [mock-provider] Model: mock-model'
    ))).toBe(true);
    expect(logs.some((entry) => (
      entry.level === 'info'
      && entry.message === '[TEST] [mock-provider] Completed in 25ms'
    ))).toBe(true);
  });

  test('respects minimum log level and passes stream events through unchanged', () => {
    const logs: CapturedLog[] = [];
    const middleware = loggingMiddleware({
      level: 'warn',
      logStreamEvents: true,
      logger: (level, message, data) => {
        logs.push({ level, message, data });
      },
    });

    const context = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      false,
      createLLMRequest(),
    );
    const streamEvent = textDelta('hello');

    middleware.onStart?.(context);
    middleware.onRetry?.(2, new Error('retryable'), context);
    const transformed = middleware.onStreamEvent?.(streamEvent, createStreamContext(context.state));

    expect(transformed).toEqual(streamEvent);
    expect(logs).toEqual([
      {
        level: 'warn',
        message: '[PP] [mock-provider] Retry attempt 2: retryable',
        data: undefined,
      },
    ]);
  });

  test('logs tool calls/results when enabled and suppresses them when disabled', () => {
    const tool: Tool<{ city: string }, { tempC: number }> = {
      name: 'weather_lookup',
      description: 'Gets current weather for a city.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
        required: ['city'],
      },
      run: async () => ({ tempC: 21 }),
    };
    const context = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      false,
      createLLMRequest(),
    );

    const enabledLogs: CapturedLog[] = [];
    const enabledMiddleware = loggingMiddleware({
      level: 'debug',
      logger: (level, message, data) => {
        enabledLogs.push({ level, message, data });
      },
    });

    enabledMiddleware.onToolCall?.(tool, { city: 'Austin' }, context);
    enabledMiddleware.onToolResult?.(tool, { tempC: 22 }, context);

    expect(enabledLogs.some((entry) => (
      entry.level === 'info'
      && entry.message === '[PP] [mock-provider] Tool call: weather_lookup'
    ))).toBe(true);
    expect(enabledLogs.some((entry) => (
      entry.level === 'debug'
      && entry.message === '[PP] [mock-provider] Tool params:'
      && entry.data?.params === undefined
    ))).toBe(false);
    expect(enabledLogs.some((entry) => (
      entry.level === 'debug'
      && entry.message === '[PP] [mock-provider] Tool result: weather_lookup'
      && entry.data?.result === undefined
    ))).toBe(false);

    const paramsLog = enabledLogs.find((entry) => (
      entry.level === 'debug'
      && entry.message === '[PP] [mock-provider] Tool params:'
    ));
    const resultLog = enabledLogs.find((entry) => (
      entry.level === 'debug'
      && entry.message === '[PP] [mock-provider] Tool result: weather_lookup'
    ));

    expect(paramsLog?.data).toEqual({ params: { city: 'Austin' } });
    expect(resultLog?.data).toEqual({ result: { tempC: 22 } });

    const disabledLogs: CapturedLog[] = [];
    const disabledMiddleware = loggingMiddleware({
      level: 'debug',
      logToolCalls: false,
      logger: (level, message, data) => {
        disabledLogs.push({ level, message, data });
      },
    });

    disabledMiddleware.onToolCall?.(tool, { city: 'Austin' }, context);
    disabledMiddleware.onToolResult?.(tool, { tempC: 22 }, context);

    expect(disabledLogs).toHaveLength(0);
  });

  test('logs aborts as warn and failures as error', () => {
    const logs: CapturedLog[] = [];
    const middleware = loggingMiddleware({
      level: 'warn',
      logger: (level, message, data) => {
        logs.push({ level, message, data });
      },
    });
    const context = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      false,
      createLLMRequest(),
    );

    middleware.onAbort?.(new Error('client disconnected'), context);
    middleware.onError?.(new Error('provider failed'), context);

    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe('warn');
    expect(logs[0]?.message).toContain('[PP] [mock-provider] Aborted after');
    expect(logs[0]?.message).toContain('client disconnected');
    expect(logs[1]?.level).toBe('error');
    expect(logs[1]?.message).toContain('[PP] [mock-provider] Error after');
    expect(logs[1]?.message).toContain('provider failed');
  });
});
