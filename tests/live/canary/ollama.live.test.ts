import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { ollama } from '../../../src/ollama/index.ts';
import type { OllamaLLMParams } from '../../../src/ollama/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_OLLAMA_ENV = Boolean(process.env.OLLAMA_TEST_MODEL || process.env.OLLAMA_TEST_HOST);
const MODEL = envModel('OLLAMA_TEST_MODEL', 'gemma3:4b');
const HOST = process.env.OLLAMA_TEST_HOST ?? 'http://localhost:11434';

describe.skipIf(!HAS_OLLAMA_ENV)('Ollama live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(MODEL),
      config: {
        baseUrl: HOST,
      },
      params: {
        num_predict: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 90000);

  test('stream yields text and resolves final turn', async () => {
    const model = llm<OllamaLLMParams>({
      model: ollama(MODEL),
      config: {
        baseUrl: HOST,
      },
      params: {
        num_predict: 120,
      },
    });

    const result = await collectTextStream(model.stream('Reply with one short sentence about stable interfaces.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 90000);
});
