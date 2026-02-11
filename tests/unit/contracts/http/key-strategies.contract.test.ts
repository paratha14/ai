import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  dynamicKey,
  maskApiKey,
  resolveApiKey,
  roundRobinKeys,
  weightedKeys,
} from '../../../../src/http/keys.ts';
import { ErrorCode } from '../../../../src/types/errors.ts';

describe('API key strategy contracts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('roundRobinKeys snapshots input and cycles deterministically', () => {
    const keys = ['k1', 'k2', 'k3'];
    const strategy = roundRobinKeys(keys);

    keys[0] = 'mutated';

    expect(strategy.getKey()).toBe('k1');
    expect(strategy.getKey()).toBe('k2');
    expect(strategy.getKey()).toBe('k3');
    expect(strategy.getKey()).toBe('k1');
  });

  test('weightedKeys follows probability buckets', () => {
    const randomSpy = spyOn(Math, 'random');
    randomSpy
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.95);

    const strategy = weightedKeys([
      { key: 'a', weight: 1 },
      { key: 'b', weight: 2 },
      { key: 'c', weight: 7 },
    ]);

    expect(strategy.getKey()).toBe('a');
    expect(strategy.getKey()).toBe('b');
    expect(strategy.getKey()).toBe('c');

    randomSpy.mockRestore();
  });

  test('dynamicKey supports async selectors', async () => {
    let callCount = 0;
    const strategy = dynamicKey(async () => {
      callCount += 1;
      return `dynamic-${callCount}`;
    });

    expect(await strategy.getKey()).toBe('dynamic-1');
    expect(await strategy.getKey()).toBe('dynamic-2');
  });

  test('resolveApiKey prioritizes config over environment fallback', async () => {
    process.env.OPENAI_API_KEY = 'env-key';

    const key = await resolveApiKey(
      { apiKey: 'config-key' },
      'OPENAI_API_KEY',
      'openai',
      'llm',
    );

    expect(key).toBe('config-key');
  });

  test('resolveApiKey resolves environment fallback and normalized auth errors', async () => {
    process.env.TEST_PROVIDER_KEY = 'env-key';

    const envResolvedKey = await resolveApiKey(
      {},
      'TEST_PROVIDER_KEY',
      'test-provider',
      'embedding',
    );
    expect(envResolvedKey).toBe('env-key');

    await expect(resolveApiKey(
      {},
      'MISSING_PROVIDER_KEY',
      'test-provider',
      'image',
    )).rejects.toMatchObject({
      code: ErrorCode.AuthenticationFailed,
      provider: 'test-provider',
      modality: 'image',
    });
  });

  test('maskApiKey never returns the full secret', () => {
    const secret = 'sk-proj-super-secret-12345';
    const masked = maskApiKey(secret);

    expect(masked).not.toBe(secret);
    expect(masked).toMatch(/^.{4}\.\.\..{4}$/);
    expect(maskApiKey('short')).toBe('***');
  });
});
