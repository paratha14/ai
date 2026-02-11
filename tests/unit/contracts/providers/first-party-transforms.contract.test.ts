import { describe, expect, test } from 'bun:test';
import { transformRequest as transformGroqRequest } from '../../../../src/providers/groq/transform.ts';
import { transformRequest as transformCerebrasRequest } from '../../../../src/providers/cerebras/transform.ts';
import { transformRequest as transformMoonshotRequest } from '../../../../src/providers/moonshot/transform.ts';
import { transformRequest as transformOllamaRequest } from '../../../../src/providers/ollama/transform.ts';
import { transformRequest as transformResponsesRequest } from '../../../../src/providers/responses/transform.ts';
import { transformRequest as transformOpenRouterResponsesRequest } from '../../../../src/providers/openrouter/transform.responses.ts';
import type { MoonshotTool } from '../../../../src/providers/moonshot/types.ts';
import type { ResponsesParams } from '../../../../src/providers/responses/types.ts';
import type { Tool } from '../../../../src/types/tool.ts';
import { AssistantMessage, ToolResultMessage, UserMessage } from '../../../../src/types/messages.ts';

function createTestTool(name: string): Tool<Record<string, unknown>, string> {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    run: (params: Record<string, unknown>) => JSON.stringify(params),
  };
}

describe('First-party provider transform contracts', () => {
  test('Groq normalizes system blocks, expands tool results, and emits strict schema output', () => {
    const transformed = transformGroqRequest(
      {
        messages: [
          new ToolResultMessage([
            { toolCallId: 'call-1', result: { ok: true } },
            { toolCallId: 'call-2', result: 'done' },
          ]),
        ],
        system: [{ text: 'Line one' }, { text: 'Line two' }],
        structure: {
          type: 'object',
          properties: {
            verdict: { type: 'string' },
          },
          required: ['verdict'],
        },
        config: {},
      },
      'llama-3.3-70b-versatile',
    );

    expect(transformed.messages[0]).toEqual({
      role: 'system',
      content: 'Line one\n\nLine two',
    });
    expect(transformed.messages.slice(1)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({ ok: true }),
      },
      {
        role: 'tool',
        tool_call_id: 'call-2',
        content: 'done',
      },
    ]);

    expect(transformed.response_format?.type).toBe('json_schema');
    if (transformed.response_format?.type === 'json_schema') {
      expect(transformed.response_format.json_schema.strict).toBe(true);
      expect(transformed.response_format.json_schema.schema.additionalProperties).toBe(false);
      expect(transformed.response_format.json_schema.schema.required).toEqual(['verdict']);
    }
  });

  test('Cerebras emits strict json_schema response format for structured output', () => {
    const transformed = transformCerebrasRequest(
      {
        messages: [new UserMessage('Return JSON with an answer field.')],
        structure: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
          required: ['answer'],
        },
        config: {},
      },
      'llama-3.3-70b',
    );

    expect(transformed.response_format?.type).toBe('json_schema');
    if (transformed.response_format?.type === 'json_schema') {
      expect(transformed.response_format.json_schema.strict).toBe(true);
      expect(transformed.response_format.json_schema.schema.additionalProperties).toBe(false);
      expect(transformed.response_format.json_schema.schema.required).toEqual(['answer']);
    }
  });

  test('Cerebras rejects image input blocks in request transformation', () => {
    expect(() => transformCerebrasRequest(
      {
        messages: [
          new UserMessage([
            {
              type: 'image',
              mimeType: 'image/png',
              source: {
                type: 'url',
                url: 'https://example.com/image.png',
              },
            },
          ]),
        ],
        config: {},
      },
      'llama-3.3-70b',
    )).toThrow('Cerebras does not support image input');
  });

  test('Moonshot merges built-in params.tools with request.tools and forwards reasoning_content', () => {
    const builtinTool: MoonshotTool = {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    };

    const transformed = transformMoonshotRequest(
      {
        messages: [
          new AssistantMessage(
            [],
            [
              {
                toolCallId: 'call-lookup',
                toolName: 'lookup',
                arguments: { id: '123' },
              },
            ],
            {
              metadata: {
                moonshot: {
                  reasoning_content: 'Thinking trace',
                },
              },
            },
          ),
        ],
        tools: [createTestTool('lookup')],
        params: {
          tools: [builtinTool],
        },
        config: {},
      },
      'kimi-k2.5',
    );

    expect(transformed.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'Thinking trace',
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
    });
    expect(transformed.tools?.map((tool) => tool.function.name)).toEqual([
      'web_search',
      'lookup',
    ]);
  });

  test('Ollama separates top-level params from options and normalizes assistant/tool history', () => {
    const structure = {
      type: 'object' as const,
      properties: {
        summary: { type: 'string' as const },
      },
      required: ['summary'],
      additionalProperties: false,
    };

    const transformed = transformOllamaRequest(
      {
        messages: [
          new AssistantMessage([{ type: 'text', text: '<think>hidden</think>\nAnswer' }]),
          new ToolResultMessage([{ toolCallId: 'lookup_2', result: { ok: true } }]),
        ],
        params: {
          keep_alive: '5m',
          think: 'medium',
          logprobs: true,
          top_logprobs: 3,
          temperature: 0.2,
          num_predict: 64,
        },
        structure,
        config: {},
      },
      'llama3.2',
    );

    expect(transformed.keep_alive).toBe('5m');
    expect(transformed.think).toBe('medium');
    expect(transformed.logprobs).toBe(true);
    expect(transformed.top_logprobs).toBe(3);
    expect(transformed.options).toEqual({
      temperature: 0.2,
      num_predict: 64,
    });
    expect(transformed.messages[0]).toEqual({
      role: 'assistant',
      content: 'Answer',
    });
    expect(transformed.messages[1]).toEqual({
      role: 'tool',
      tool_name: 'lookup',
      content: JSON.stringify({ ok: true }),
    });
    expect(transformed.format).toEqual(structure);
  });

  test('Responses provider collapses simple user input and merges built-in + function tools', () => {
    const params: ResponsesParams = {
      tools: [{ type: 'web_search_preview' }],
    };

    const transformed = transformResponsesRequest(
      {
        messages: [new UserMessage('Summarize this in JSON.')],
        tools: [createTestTool('lookup')],
        structure: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
        params,
        config: {},
      },
      'gpt-4.1-mini',
    );

    expect(transformed.input).toBe('Summarize this in JSON.');
    const tools = transformed.tools ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: 'function',
      name: 'lookup',
      description: 'lookup tool',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
        additionalProperties: false,
      },
    });
    expect(tools[1]).toEqual({ type: 'web_search_preview' });

    expect(transformed.text?.format?.type).toBe('json_schema');
    if (transformed.text?.format?.type === 'json_schema') {
      expect(transformed.text.format.strict).toBe(true);
      expect(transformed.text.format.schema.additionalProperties).toBe(false);
      expect(transformed.text.format.schema.required).toEqual(['summary']);
    }
  });

  test('OpenRouter responses mode preserves cache_control system blocks and tool outputs', () => {
    const transformed = transformOpenRouterResponsesRequest(
      {
        messages: [
          new ToolResultMessage([
            { toolCallId: 'call-1', result: { ok: true } },
            { toolCallId: 'call-2', result: 'done' },
          ]),
        ],
        system: [
          {
            type: 'text',
            text: 'Keep this prompt cached.',
            cache_control: {
              type: 'ephemeral',
              ttl: '1h',
            },
          },
        ],
        structure: {
          type: 'object',
          properties: {
            result: { type: 'string' },
          },
          required: ['result'],
        },
        config: {},
      },
      'openai/gpt-4o-mini',
    );

    expect(Array.isArray(transformed.input)).toBe(true);
    if (Array.isArray(transformed.input)) {
      expect(transformed.input[0]).toEqual({
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'Keep this prompt cached.',
            cache_control: {
              type: 'ephemeral',
              ttl: '1h',
            },
          },
        ],
      });
      expect(transformed.input.slice(1)).toEqual([
        {
          type: 'function_call_output',
          id: 'fco_call-1_0',
          call_id: 'call-1',
          output: JSON.stringify({ ok: true }),
        },
        {
          type: 'function_call_output',
          id: 'fco_call-2_1',
          call_id: 'call-2',
          output: 'done',
        },
      ]);
    }

    expect(transformed.text?.format?.type).toBe('json_schema');
    if (transformed.text?.format?.type === 'json_schema') {
      expect(transformed.text.format.strict).toBe(true);
      expect(transformed.text.format.schema.additionalProperties).toBe(false);
      expect(transformed.text.format.schema.required).toEqual(['result']);
    }
  });
});
