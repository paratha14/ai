import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { llm } from '../../../src/index.ts';
import { anthropic } from '../../../src/anthropic/index.ts';
import type { AnthropicLLMParams } from '../../../src/anthropic/index.ts';
import { openai } from '../../../src/openai/index.ts';
import type { OpenAIResponsesParams } from '../../../src/openai/index.ts';
import { proxy, parseBody, toError, toJSON, toSSE } from '../../../src/proxy/index.ts';
import type { ProxyLLMParams } from '../../../src/proxy/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

type BackingProvider = 'openai' | 'anthropic';

const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const OPENAI_MODEL = envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini');
const ANTHROPIC_MODEL = envModel('ANTHROPIC_TEST_MODEL', 'claude-3-5-haiku-latest');
const PROXY_PATH = '/api/canary-proxy';

function buildServer(backingProvider: BackingProvider): Server<unknown> {
  return Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== PROXY_PATH) {
        return new Response('Not found', { status: 404 });
      }

      try {
        const body = await req.json();
        const { messages, system } = parseBody(body);
        const wantsStream = req.headers.get('accept')?.includes('text/event-stream') ?? false;

        if (backingProvider === 'openai') {
          const model = llm<OpenAIResponsesParams>({
            model: openai(OPENAI_MODEL),
            system,
            params: {
              max_output_tokens: 120,
            },
          });

          if (wantsStream) {
            return toSSE(model.stream(messages));
          }
          return toJSON(await model.generate(messages));
        }

        const model = llm<AnthropicLLMParams>({
          model: anthropic(ANTHROPIC_MODEL),
          system,
          params: {
            max_tokens: 120,
          },
        });

        if (wantsStream) {
          return toSSE(model.stream(messages));
        }
        return toJSON(await model.generate(messages));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toError(message, 400);
      }
    },
  });
}

function runProxyCanarySuite(backingProvider: BackingProvider): void {
  const shouldSkip = backingProvider === 'openai' ? !HAS_OPENAI_KEY : !HAS_ANTHROPIC_KEY;

  describe.skipIf(shouldSkip)(`Proxy live canary (${backingProvider})`, () => {
    let server: Server<unknown> | undefined;
    let endpoint = '';

    beforeAll(() => {
      server = buildServer(backingProvider);

      endpoint = `http://127.0.0.1:${server.port}${PROXY_PATH}`;
    });

    afterAll(() => {
      server?.stop(true);
    });

    test('generate proxies through live provider', async () => {
      const model = llm<ProxyLLMParams>({
        model: proxy({ endpoint })('canary'),
      });

      const turn = await model.generate('Reply with one short sentence that includes the word canary.');

      expect(turn.response.text.length).toBeGreaterThan(0);
      expect(turn.response.text.toLowerCase()).toContain('canary');
    }, 120000);

    test('stream proxies events and resolves final turn', async () => {
      const model = llm<ProxyLLMParams>({
        model: proxy({ endpoint })('canary'),
      });

      const result = await collectTextStream(model.stream('Reply with one short sentence about proxy reliability.'));

      expect(result.eventCount).toBeGreaterThan(0);
      expect(result.turn.response.text.length).toBeGreaterThan(0);
    }, 120000);
  });
}

runProxyCanarySuite('openai');
runProxyCanarySuite('anthropic');
