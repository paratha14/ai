import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { responses } from '../../../src/responses/index.ts';
import type { ResponsesParams } from '../../../src/responses/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_OPENRESPONSES_KEY = Boolean(process.env.OPENRESPONSES_API_KEY);
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY);
const HAS_RESPONSES_KEY = HAS_OPENRESPONSES_KEY || HAS_OPENAI_KEY;

const RESPONSES_HOST = process.env.OPENRESPONSES_TEST_HOST ?? 'https://api.openai.com/v1';
const MODEL = envModel('OPENRESPONSES_TEST_MODEL', envModel('OPENAI_TEST_MODEL', 'gpt-4o-mini'));
const API_KEY_ENV = HAS_OPENRESPONSES_KEY ? 'OPENRESPONSES_API_KEY' : 'OPENAI_API_KEY';

describe.skipIf(!HAS_RESPONSES_KEY)('OpenResponses live canary', () => {
  test('generate returns text through OpenResponses host', async () => {
    const model = llm<ResponsesParams>({
      model: responses(MODEL, {
        host: RESPONSES_HOST,
        apiKeyEnv: API_KEY_ENV,
      }),
      params: {
        max_output_tokens: 120,
      },
    });

    const turn = await model.generate('Reply with one short sentence containing the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream emits events and resolves turn', async () => {
    const model = llm<ResponsesParams>({
      model: responses(MODEL, {
        host: RESPONSES_HOST,
        apiKeyEnv: API_KEY_ENV,
      }),
      params: {
        max_output_tokens: 120,
      },
    });

    const result = await collectTextStream(model.stream('Write one short sentence about protocol compatibility.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
