import { describe, expect, test } from 'bun:test';
import { llm } from '../../../../src/core/llm.ts';
import { AssistantMessage, ToolResultMessage } from '../../../../src/types/messages.ts';
import type { LLMRequest, LLMResponse } from '../../../../src/types/llm.ts';
import type { Tool } from '../../../../src/types/tool.ts';
import {
  createMockLLMProvider,
  createTextResponse,
  createUsage,
} from '../../../helpers/mock-llm-provider.ts';

interface EchoParams {
  text: string;
  suffix?: string;
}

interface EchoResult {
  output: string;
}

function expectEchoParams(params: unknown): EchoParams {
  if (typeof params !== 'object' || params === null) {
    throw new Error('Expected tool params to be an object');
  }

  const maybeParams = params as { text?: unknown; suffix?: unknown };
  if (typeof maybeParams.text !== 'string') {
    throw new Error('Expected tool params.text to be a string');
  }

  if (maybeParams.suffix !== undefined && typeof maybeParams.suffix !== 'string') {
    throw new Error('Expected tool params.suffix to be a string when provided');
  }

  return {
    text: maybeParams.text,
    ...(maybeParams.suffix !== undefined ? { suffix: maybeParams.suffix } : {}),
  };
}

function expectEchoResult(result: unknown): EchoResult {
  if (typeof result !== 'object' || result === null) {
    throw new Error('Expected tool result to be an object');
  }

  const maybeResult = result as { output?: unknown };
  if (typeof maybeResult.output !== 'string') {
    throw new Error('Expected tool result.output to be a string');
  }

  return { output: maybeResult.output };
}

function createToolCallResponse(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): LLMResponse {
  return {
    message: new AssistantMessage('Calling tool...', [
      {
        toolCallId,
        toolName,
        arguments: args,
      },
    ]),
    usage: createUsage(4, 4),
    stopReason: 'tool_use',
  };
}

function expectToolResultMessage(request: LLMRequest<Record<string, never>>): ToolResultMessage {
  const toolResultMessage = request.messages.find((message) => message.type === 'tool_result');
  if (!(toolResultMessage instanceof ToolResultMessage)) {
    throw new Error('Expected request to include a ToolResultMessage');
  }
  return toolResultMessage;
}

function expectRequestAt(
  requests: Array<LLMRequest<Record<string, never>>>,
  index: number,
): LLMRequest<Record<string, never>> {
  const request = requests[index];
  if (!request) {
    throw new Error(`Expected request at index ${index}`);
  }
  return request;
}

describe('Tool strategy contracts', () => {
  test('applies onBeforeCall/onAfterCall transformations end-to-end', async () => {
    const requests: Array<LLMRequest<Record<string, never>>> = [];
    let executedParams: EchoParams | undefined;

    const provider = createMockLLMProvider({
      onComplete: (request, attempt): { response: LLMResponse } => {
        requests.push(request);
        if (attempt === 1) {
          return {
            response: createToolCallResponse('call-echo', 'echo', { text: 'ping' }),
          };
        }

        return {
          response: createTextResponse('done', createUsage(2, 2)),
        };
      },
    });

    const echoTool: Tool<EchoParams, EchoResult> = {
      name: 'echo',
      description: 'Echoes back text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          suffix: { type: 'string' },
        },
        required: ['text'],
      },
      run: async (params: EchoParams): Promise<EchoResult> => {
        executedParams = params;
        return {
          output: `${params.text}${params.suffix ?? ''}`,
        };
      },
    };

    const model = llm({
      model: provider('mock-tool-transform'),
      tools: [echoTool],
      toolStrategy: {
        onBeforeCall(_tool, params) {
          const normalized = expectEchoParams(params);
          return {
            proceed: true,
            params: {
              ...normalized,
              suffix: '!',
            },
          };
        },
        onAfterCall(_tool, _params, result) {
          const normalized = expectEchoResult(result);
          return {
            result: {
              output: `[${normalized.output}]`,
            },
          };
        },
      },
    });

    const turn = await model.generate('use echo');

    expect(executedParams).toEqual({ text: 'ping', suffix: '!' });
    expect(turn.toolExecutions).toHaveLength(1);
    expect(turn.toolExecutions[0]?.arguments).toEqual({ text: 'ping', suffix: '!' });
    expect(turn.toolExecutions[0]?.result).toEqual({ output: '[ping!]' });

    const toolResultMessage = expectToolResultMessage(expectRequestAt(requests, 1));
    expect(toolResultMessage.results[0]).toMatchObject({
      toolCallId: 'call-echo',
      result: { output: '[ping!]' },
      isError: false,
    });
  });

  test('invokes onError when onBeforeCall blocks execution', async () => {
    const requests: Array<LLMRequest<Record<string, never>>> = [];
    let runCalls = 0;
    let errorFromHook: string | undefined;
    let errorParams: EchoParams | undefined;

    const provider = createMockLLMProvider({
      onComplete: (request, attempt): { response: LLMResponse } => {
        requests.push(request);
        if (attempt === 1) {
          return {
            response: createToolCallResponse('call-skip', 'echo', { text: 'blocked' }),
          };
        }

        return {
          response: createTextResponse('handled skip', createUsage(2, 2)),
        };
      },
    });

    const echoTool: Tool<EchoParams, EchoResult> = {
      name: 'echo',
      description: 'Echoes back text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      run: async (): Promise<EchoResult> => {
        runCalls += 1;
        return { output: 'should-not-run' };
      },
    };

    const model = llm({
      model: provider('mock-tool-skip'),
      tools: [echoTool],
      toolStrategy: {
        onBeforeCall() {
          return { proceed: false };
        },
        onError(_tool, params, error) {
          errorFromHook = error.message;
          errorParams = expectEchoParams(params);
        },
      },
    });

    const turn = await model.generate('skip echo');

    expect(runCalls).toBe(0);
    expect(errorFromHook).toBe('Tool execution skipped');
    expect(errorParams).toEqual({ text: 'blocked' });
    expect(turn.toolExecutions[0]).toMatchObject({
      toolCallId: 'call-skip',
      toolName: 'echo',
      arguments: { text: 'blocked' },
      result: 'Tool execution skipped',
      isError: true,
    });

    const toolResultMessage = expectToolResultMessage(expectRequestAt(requests, 1));
    expect(toolResultMessage.results[0]).toEqual({
      toolCallId: 'call-skip',
      result: 'Tool execution skipped',
      isError: true,
    });
  });

  test('invokes onError for thrown tool failures and does not run onAfterCall', async () => {
    let afterCallCount = 0;
    let errorHookCount = 0;
    let hookErrorMessage: string | undefined;

    const provider = createMockLLMProvider({
      onComplete: (_request, attempt): { response: LLMResponse } => {
        if (attempt === 1) {
          return {
            response: createToolCallResponse('call-fail', 'echo', { text: 'boom' }),
          };
        }

        return {
          response: createTextResponse('handled throw', createUsage(2, 2)),
        };
      },
    });

    const echoTool: Tool<EchoParams, EchoResult> = {
      name: 'echo',
      description: 'Echoes back text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
      run: async (): Promise<EchoResult> => {
        throw new Error('tool exploded');
      },
    };

    const model = llm({
      model: provider('mock-tool-error'),
      tools: [echoTool],
      toolStrategy: {
        onAfterCall() {
          afterCallCount += 1;
        },
        onError(_tool, params, error) {
          errorHookCount += 1;
          hookErrorMessage = error.message;
          expect(expectEchoParams(params)).toEqual({ text: 'boom' });
        },
      },
    });

    const turn = await model.generate('throw from tool');

    expect(errorHookCount).toBe(1);
    expect(hookErrorMessage).toBe('tool exploded');
    expect(afterCallCount).toBe(0);
    expect(turn.toolExecutions[0]).toMatchObject({
      toolCallId: 'call-fail',
      toolName: 'echo',
      arguments: { text: 'boom' },
      result: 'tool exploded',
      isError: true,
    });
  });
});
