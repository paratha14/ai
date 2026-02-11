import { describe, expect, test } from 'bun:test';
import { llm } from '../../../../src/core/llm.ts';
import { AssistantMessage, UserMessage } from '../../../../src/types/messages.ts';
import { ErrorCode, ModalityType, UPPError } from '../../../../src/types/errors.ts';
import type { ImageBlock } from '../../../../src/types/content.ts';
import type { LLMRequest, LLMResponse } from '../../../../src/types/llm.ts';
import type { Tool } from '../../../../src/types/tool.ts';
import {
  createMockLLMProvider,
  createTextResponse,
  createUsage,
} from '../../../helpers/mock-llm-provider.ts';

describe('LLM core contracts', () => {
  test('runs a tool loop and sends tool results in the next cycle', async () => {
    const requests: Array<LLMRequest<Record<string, never>>> = [];

    const provider = createMockLLMProvider({
      onComplete: (request, attempt): { response: LLMResponse } => {
        requests.push(request);

        if (attempt === 1) {
          return {
            response: {
              message: new AssistantMessage('Calling tool...', [
                {
                  toolCallId: 'call-add',
                  toolName: 'add',
                  arguments: { a: 2, b: 3 },
                },
              ]),
              usage: createUsage(5, 4),
              stopReason: 'tool_use',
            },
          };
        }

        return {
          response: createTextResponse('The answer is 5.', createUsage(3, 7)),
        };
      },
    });

    const addTool: Tool<{ a: number; b: number }, { sum: number }> = {
      name: 'add',
      description: 'Adds two integers.',
      parameters: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      run: async (params: { a: number; b: number }) => ({
        sum: params.a + params.b,
      }),
    };

    const model = llm({
      model: provider('mock-tool-loop'),
      tools: [addTool],
    });

    const turn = await model.generate('What is 2 + 3?');

    expect(turn.cycles).toBe(2);
    expect(turn.toolExecutions).toHaveLength(1);
    expect(turn.toolExecutions[0]?.toolName).toBe('add');
    expect(turn.toolExecutions[0]?.result).toEqual({ sum: 5 });
    expect(turn.response.text).toContain('5');
    expect(requests[1]?.messages.some((message) => message.type === 'tool_result')).toBe(true);
  });

  test('denies tool execution when approval returns false', async () => {
    let runCalls = 0;

    const provider = createMockLLMProvider({
      onComplete: (_request, attempt): { response: LLMResponse } => {
        if (attempt === 1) {
          return {
            response: {
              message: new AssistantMessage('Need approval.', [
                {
                  toolCallId: 'call-sensitive',
                  toolName: 'sensitive_tool',
                  arguments: { value: 42 },
                },
              ]),
              usage: createUsage(4, 4),
              stopReason: 'tool_use',
            },
          };
        }

        return {
          response: createTextResponse('I cannot run that action.', createUsage(2, 5)),
        };
      },
    });

    const sensitiveTool: Tool<{ value: number }, { accepted: boolean }> = {
      name: 'sensitive_tool',
      description: 'Requires explicit approval before execution.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'number' },
        },
        required: ['value'],
      },
      approval: async () => false,
      run: async () => {
        runCalls += 1;
        return { accepted: true };
      },
    };

    const model = llm({
      model: provider('mock-approval'),
      tools: [sensitiveTool],
    });

    const turn = await model.generate('Execute the sensitive tool.');

    expect(runCalls).toBe(0);
    expect(turn.toolExecutions).toHaveLength(1);
    expect(turn.toolExecutions[0]?.isError).toBe(true);
    expect(turn.toolExecutions[0]?.approved).toBe(false);
    expect(turn.toolExecutions[0]?.result).toBe('Tool execution denied');
  });

  test('throws INVALID_REQUEST when structured output is not supported', async () => {
    const provider = createMockLLMProvider({
      capabilities: {
        structuredOutput: false,
      },
    });

    let error: unknown;
    try {
      llm({
        model: provider('mock-no-structured-output'),
        structure: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
          required: ['answer'],
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UPPError);
    expect(error).toMatchObject({
      code: ErrorCode.InvalidRequest,
      modality: ModalityType.LLM,
    });
  });

  test('throws INVALID_REQUEST on unsupported image input', async () => {
    const provider = createMockLLMProvider({
      capabilities: {
        imageInput: false,
      },
    });

    const model = llm({
      model: provider('mock-no-image'),
    });

    const imageBlock: ImageBlock = {
      type: 'image',
      source: {
        type: 'url',
        url: 'https://example.com/image.png',
      },
      mimeType: 'image/png',
    };

    await expect(model.generate(new UserMessage([imageBlock]))).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      modality: ModalityType.LLM,
    });
  });

  test('passes params through unchanged to provider request', async () => {
    interface CustomParams {
      temperature: number;
      customFlag: boolean;
    }

    const params: CustomParams = {
      temperature: 0.2,
      customFlag: true,
    };

    let receivedParams: CustomParams | undefined;

    const provider = createMockLLMProvider<CustomParams>({
      onComplete: (request): { response: LLMResponse } => {
        receivedParams = request.params;
        return {
          response: createTextResponse('ok', createUsage(1, 1)),
        };
      },
    });

    const model = llm<CustomParams>({
      model: provider('mock-params'),
      params,
    });

    await model.generate('Ping');

    expect(receivedParams).toEqual(params);
  });

  test('exposes cancellation as UPPError with CANCELLED code', async () => {
    const provider = createMockLLMProvider({
      onComplete: (): { error: Error } => {
        const cancelled = new UPPError(
          'Cancelled',
          ErrorCode.Cancelled,
          'mock',
          ModalityType.LLM,
        );
        return { error: cancelled };
      },
    });

    const model = llm({
      model: provider('mock-cancelled'),
    });

    await expect(model.generate('Will cancel')).rejects.toMatchObject({
      code: ErrorCode.Cancelled,
    });
  });
});
