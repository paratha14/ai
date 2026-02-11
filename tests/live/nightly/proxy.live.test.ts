import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { llm } from '../../../src/index.ts';
import { proxy } from '../../../src/proxy/index.ts';
import {
  parseBody,
  toJSON,
  toSSE,
} from '../../../src/proxy/server/webapi.ts';
import {
  AssistantMessage,
  ToolResultMessage,
} from '../../../src/types/messages.ts';
import {
  createStreamResult,
  textDelta,
  type StreamEvent,
} from '../../../src/types/stream.ts';
import { createTurn, emptyUsage } from '../../../src/types/turn.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';
import type { ProxyLLMParams } from '../../../src/proxy/index.ts';
import { ErrorCode, UPPError } from '../../../src/types/errors.ts';
import {
  collectTextStream,
  createAddTool,
} from '../../helpers/live.ts';

const RUN_PROXY_LIVE = process.env.RUN_PROXY_LIVE !== '0';
const INVALID_MODEL = 'pp-nightly-invalid-model';

const STRUCTURE: JSONSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'confidence'],
  additionalProperties: false,
};

interface StructuredContract {
  verdict: string;
  confidence: number;
}

function isStructuredContract(value: unknown): value is StructuredContract {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.verdict === 'string' && typeof candidate.confidence === 'number';
}

function extractSumFromToolResult(messages: ReturnType<typeof parseBody>['messages']): number | undefined {
  const toolResult = [...messages]
    .reverse()
    .find((message): message is ToolResultMessage => message.type === 'tool_result');

  const firstResult = toolResult?.results[0]?.result;
  if (!firstResult || typeof firstResult !== 'object') {
    return undefined;
  }

  const payload = firstResult as Record<string, unknown>;
  return typeof payload.sum === 'number' ? payload.sum : undefined;
}

function expectInvalidModelError(error: unknown): void {
  expect(error).toBeInstanceOf(UPPError);
  const uppError = error as UPPError;

  expect(uppError.provider).toBe('proxy');
  expect(uppError.code).toBe(ErrorCode.InvalidRequest);
}

describe.skipIf(!RUN_PROXY_LIVE)('Proxy live nightly', () => {
  let server: ReturnType<typeof Bun.serve>;
  let endpoint = '';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method !== 'POST') {
          return new Response('Not found', { status: 404 });
        }

        let parsed: ReturnType<typeof parseBody>;
        try {
          parsed = parseBody(await request.json());
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid request body';
          return new Response(JSON.stringify({ error: message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (parsed.model === INVALID_MODEL) {
          return new Response(JSON.stringify({ error: 'Model not available for proxy nightly test' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const wantsStream = request.headers.get('accept')?.includes('text/event-stream') ?? false;
        if (wantsStream) {
          async function* streamGenerator(): AsyncGenerator<StreamEvent, void, unknown> {
            yield textDelta('proxy ');
            yield textDelta('stream ');
            yield textDelta('contract ok');
          }

          const finalTurn = createTurn(
            [...parsed.messages, new AssistantMessage('proxy stream contract ok')],
            [],
            emptyUsage(),
            1,
          );

          const stream = createStreamResult(
            streamGenerator(),
            Promise.resolve(finalTurn),
            new AbortController(),
          );

          return toSSE(stream);
        }

        const sum = extractSumFromToolResult(parsed.messages);
        if (typeof sum === 'number') {
          const turn = createTurn(
            [...parsed.messages, new AssistantMessage(`sum=${sum}`)],
            [],
            emptyUsage(),
            1,
          );
          return toJSON(turn);
        }

        const hasAddTool = parsed.tools?.some((tool) => tool.name === 'add') ?? false;
        if (hasAddTool) {
          const turn = createTurn(
            [
              ...parsed.messages,
              new AssistantMessage('', [
                {
                  toolCallId: 'call-add',
                  toolName: 'add',
                  arguments: { a: 2, b: 3 },
                },
              ]),
            ],
            [],
            emptyUsage(),
            1,
          );
          return toJSON(turn);
        }

        if (parsed.structure) {
          const payload: StructuredContract = {
            verdict: 'positive',
            confidence: 0.99,
          };

          const turn = createTurn(
            [...parsed.messages, new AssistantMessage(JSON.stringify(payload))],
            [],
            emptyUsage(),
            1,
            payload,
          );
          return toJSON(turn);
        }

        const turn = createTurn(
          [...parsed.messages, new AssistantMessage('proxy nightly default response')],
          [],
          emptyUsage(),
          1,
        );
        return toJSON(turn);
      },
    });

    endpoint = server.url.toString();
  });

  afterAll(() => {
    server.stop(true);
  });

  test('structured output survives proxy JSON transport', async () => {
    const model = llm<ProxyLLMParams>({
      model: proxy({ endpoint })('default'),
      structure: STRUCTURE,
    });

    const turn = await model.generate('Return nightly contract data.');

    expect(isStructuredContract(turn.data)).toBe(true);
    if (isStructuredContract(turn.data)) {
      expect(turn.data.verdict.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.data.confidence)).toBe(true);
    }
  }, 30000);

  test('tool loop executes add tool through proxy transport', async () => {
    const model = llm<ProxyLLMParams>({
      model: proxy({ endpoint })('default'),
      tools: [createAddTool()],
    });

    const turn = await model.generate('Use the add tool with a=2 and b=3. Then respond with sum=5.');

    const addExecution = turn.toolExecutions.find((execution) => execution.toolName === 'add' && !execution.isError);
    expect(addExecution?.result).toEqual({ sum: 5 });
    expect(turn.cycles).toBeGreaterThan(1);
    expect(turn.response.text).toContain('sum=5');
  }, 30000);

  test('stream path relays text deltas and final turn over SSE', async () => {
    const model = llm<ProxyLLMParams>({
      model: proxy({ endpoint })('default'),
    });

    const result = await collectTextStream(model.stream('Stream nightly contract state.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.text).toContain('proxy stream contract ok');
    expect(result.turn.response.text).toContain('proxy stream contract ok');
  }, 30000);

  test('invalid model returns normalized proxy error', async () => {
    const model = llm<ProxyLLMParams>({
      model: proxy({ endpoint })(INVALID_MODEL),
    });

    let caughtError: unknown;
    try {
      await model.generate('Ping');
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeDefined();
    expectInvalidModelError(caughtError);
  }, 30000);
});
