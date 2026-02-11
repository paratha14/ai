import { describe, expect, test } from 'bun:test';
import { transformRequest as transformAnthropicRequest } from '../../../../src/providers/anthropic/transform.ts';
import { transformRequest as transformOpenAICompletionsRequest } from '../../../../src/providers/openai/transform.completions.ts';
import { transformRequest as transformOpenRouterCompletionsRequest } from '../../../../src/providers/openrouter/transform.completions.ts';
import { transformRequest as transformXAICompletionsRequest } from '../../../../src/providers/xai/transform.completions.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { AssistantMessage, ToolResultMessage, UserMessage } from '../../../../src/types/messages.ts';
import type { AnthropicLLMParams } from '../../../../src/providers/anthropic/types.ts';
import type { XAICompletionsParams } from '../../../../src/providers/xai/types.ts';

describe('Provider transform contracts', () => {
  test('OpenAI completions places normalized system prompt before conversation messages', () => {
    const request = transformOpenAICompletionsRequest(
      {
        messages: [new UserMessage('Ping')],
        system: [{ text: 'Line one' }, { text: 'Line two' }],
        config: {},
      },
      'gpt-4o-mini'
    );

    expect(request.messages[0]).toEqual({
      role: 'system',
      content: 'Line one\n\nLine two',
    });
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: 'Ping',
    });
  });

  test('OpenAI completions expands tool results into separate tool messages', () => {
    const request = transformOpenAICompletionsRequest(
      {
        messages: [
          new ToolResultMessage([
            { toolCallId: 'call-1', result: { sum: 5 } },
            { toolCallId: 'call-2', result: 'ok' },
          ]),
        ],
        config: {},
      },
      'gpt-4o-mini'
    );

    expect(request.messages).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({ sum: 5 }),
      },
      {
        role: 'tool',
        tool_call_id: 'call-2',
        content: 'ok',
      },
    ]);
  });

  test('OpenRouter completions preserves structured system blocks with cache control', () => {
    const request = transformOpenRouterCompletionsRequest(
      {
        messages: [new UserMessage('Hello')],
        system: [
          {
            type: 'text',
            text: 'Stay concise.',
            cache_control: {
              type: 'ephemeral',
              ttl: '1h',
            },
          },
        ],
        config: {},
      },
      'openai/gpt-4o-mini'
    );

    expect(request.messages).toBeDefined();
    const messages = request.messages ?? [];
    const systemMessage = messages[0];
    expect(systemMessage?.role).toBe('system');

    if (systemMessage && Array.isArray(systemMessage.content)) {
      expect(systemMessage.content[0]).toEqual({
        type: 'text',
        text: 'Stay concise.',
        cache_control: {
          type: 'ephemeral',
          ttl: '1h',
        },
      });
    }
  });

  test('xAI completions maps assistant tool calls to null content when no text is present', () => {
    const request = transformXAICompletionsRequest(
      {
        messages: [
          new AssistantMessage([], [
            {
              toolCallId: 'call-lookup',
              toolName: 'lookup',
              arguments: { id: '123' },
            },
          ]),
        ],
        config: {},
      },
      'grok-4'
    );

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-lookup',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: JSON.stringify({ id: '123' }),
            },
          },
        ],
      },
    ]);
  });

  test('Anthropic keeps system separate from messages and maps tool results to tool_result blocks', () => {
    const request = transformAnthropicRequest(
      {
        messages: [
          new UserMessage('Start'),
          new ToolResultMessage([
            { toolCallId: 'call-a', result: { value: 1 } },
            { toolCallId: 'call-b', result: 'failed', isError: true },
          ]),
        ],
        system: 'You are terse.',
        params: { max_tokens: 64 },
        config: {},
      },
      'claude-sonnet-4-20250514'
    );

    expect(request.system).toBe('You are terse.');
    expect(request.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Start' }],
    });

    const toolResultMessage = request.messages[1];
    expect(toolResultMessage?.role).toBe('user');
    if (toolResultMessage && Array.isArray(toolResultMessage.content)) {
      expect(toolResultMessage.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'call-a',
          content: JSON.stringify({ value: 1 }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'call-b',
          content: 'failed',
          is_error: true,
        },
      ]);
    }
  });

  test('Anthropic structured output switches between native and tool fallback modes', () => {
    const baseRequest: LLMRequest<AnthropicLLMParams> = {
      messages: [new UserMessage('Return JSON with an answer field.')],
      params: { max_tokens: 128 },
      structure: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
        required: ['answer'],
        additionalProperties: false,
      },
      config: {},
    };

    const fallbackRequest = transformAnthropicRequest(
      baseRequest,
      'claude-sonnet-4-20250514',
      false
    );
    const fallbackStructuredTool = fallbackRequest.tools?.find(
      (tool) => 'name' in tool && tool.name === 'json_response'
    );

    expect(fallbackRequest.output_format).toBeUndefined();
    expect(fallbackRequest.tool_choice).toEqual({ type: 'tool', name: 'json_response' });
    expect(fallbackStructuredTool).toBeDefined();

    const nativeRequest = transformAnthropicRequest(
      baseRequest,
      'claude-sonnet-4-20250514',
      true
    );

    expect(nativeRequest.output_format).toEqual({
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
        },
        required: ['answer'],
        additionalProperties: false,
      },
    });
    expect(nativeRequest.tool_choice).toBeUndefined();
    expect(nativeRequest.tools).toBeUndefined();
  });

  test('xAI completions emits strict json_schema response_format for structured output', () => {
    const request: LLMRequest<XAICompletionsParams> = {
      messages: [new UserMessage('Return JSON with a verdict field.')],
      structure: {
        type: 'object',
        properties: {
          verdict: { type: 'string' },
        },
        required: ['verdict'],
      },
      config: {},
    };

    const transformed = transformXAICompletionsRequest(request, 'grok-4');

    expect(transformed.response_format?.type).toBe('json_schema');
    if (transformed.response_format?.type === 'json_schema') {
      expect(transformed.response_format.json_schema.strict).toBe(true);
      expect(transformed.response_format.json_schema.schema.additionalProperties).toBe(false);
      expect(transformed.response_format.json_schema.schema.required).toEqual(['verdict']);
    }
  });
});
