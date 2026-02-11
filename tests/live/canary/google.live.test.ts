import { describe, expect, test } from 'bun:test';
import { llm } from '../../../src/index.ts';
import { google } from '../../../src/google/index.ts';
import type { GoogleLLMParams } from '../../../src/google/index.ts';
import { collectTextStream, envModel } from '../../helpers/live.ts';

const HAS_GOOGLE_KEY = Boolean(process.env.GOOGLE_API_KEY);
const MODEL = envModel('GOOGLE_TEST_MODEL', 'gemini-2.0-flash');

describe.skipIf(!HAS_GOOGLE_KEY)('Google live canary', () => {
  test('generate returns non-empty text', async () => {
    const model = llm<GoogleLLMParams>({
      model: google(MODEL),
    });

    const turn = await model.generate('Reply with one short sentence that includes the word canary.');

    expect(turn.response.text.length).toBeGreaterThan(0);
    expect(turn.response.text.toLowerCase()).toContain('canary');
  }, 60000);

  test('stream yields text chunks', async () => {
    const model = llm<GoogleLLMParams>({
      model: google(MODEL),
    });

    const result = await collectTextStream(model.stream('Give one concise sentence about robust interfaces.'));

    expect(result.eventCount).toBeGreaterThan(0);
    expect(result.turn.response.text.length).toBeGreaterThan(0);
  }, 60000);
});
