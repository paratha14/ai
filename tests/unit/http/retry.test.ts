import { describe, expect, test } from 'bun:test';
import { exponentialBackoff, linearBackoff, noRetry, retryAfterStrategy } from '../../../src/http/retry.ts';
import { UPPError, ErrorCode, ModalityType } from '../../../src/types/errors.ts';

describe('exponentialBackoff', () => {
  test('retries on transient errors with exponential delays', () => {
    const factory = exponentialBackoff({ maxAttempts: 2, baseDelay: 100, maxDelay: 1000, jitter: false });
    const strategy = factory();
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(100);
    expect(strategy.onRetry(error, 2)).toBe(200);
    expect(strategy.onRetry(error, 3)).toBeNull();
  });

  test('ignores non-retryable errors', () => {
    const factory = exponentialBackoff({ maxAttempts: 3, baseDelay: 100, jitter: false });
    const strategy = factory();
    const error = new UPPError('invalid', ErrorCode.InvalidRequest, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBeNull();
  });

  test('caps delay at maxDelay', () => {
    const factory = exponentialBackoff({ maxAttempts: 5, baseDelay: 1000, maxDelay: 2500, jitter: false });
    const strategy = factory();
    const error = new UPPError('timeout', ErrorCode.Timeout, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(1000);
    expect(strategy.onRetry(error, 2)).toBe(2000);
    expect(strategy.onRetry(error, 3)).toBe(2500);
  });

  test('applies jitter within expected range', () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const factory = exponentialBackoff({ maxAttempts: 1, baseDelay: 1000, maxDelay: 10000, jitter: true });
      const strategy = factory();
      const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);
      const delay = strategy.onRetry(error, 1);
      expect(delay).toBe(500);
    } finally {
      Math.random = originalRandom;
    }
  });

  test('handles very high attempt numbers without overflow', () => {
    const factory = exponentialBackoff({
      maxAttempts: 100,
      baseDelay: 1000,
      maxDelay: 60000,
      jitter: false,
    });
    const strategy = factory();
    const error = new UPPError('timeout', ErrorCode.Timeout, 'mock', ModalityType.LLM);

    const delay = strategy.onRetry(error, 50);
    expect(delay).toBe(60000);
  });

  test('handles base delay of 0', () => {
    const factory = exponentialBackoff({
      maxAttempts: 3,
      baseDelay: 0,
      maxDelay: 1000,
      jitter: false,
    });
    const strategy = factory();
    const error = new UPPError('timeout', ErrorCode.Timeout, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(0);
    expect(strategy.onRetry(error, 2)).toBe(0);
  });

  test('factory creates isolated instances', () => {
    const factory = exponentialBackoff({ maxAttempts: 2, baseDelay: 100, jitter: false });
    const strategy1 = factory();
    const strategy2 = factory();

    expect(strategy1).not.toBe(strategy2);
  });

  test('exposes maxAttempts property', () => {
    const factory = exponentialBackoff({ maxAttempts: 5 });
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(5);
  });

  test('maxAttempts defaults to 3', () => {
    const factory = exponentialBackoff();
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(3);
  });
});

describe('linearBackoff', () => {
  test('retries with linear delay', () => {
    const factory = linearBackoff({ maxAttempts: 3, delay: 100 });
    const strategy = factory();
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(100);
    expect(strategy.onRetry(error, 2)).toBe(200);
    expect(strategy.onRetry(error, 3)).toBe(300);
    expect(strategy.onRetry(error, 4)).toBeNull();
  });

  test('ignores non-retryable errors', () => {
    const factory = linearBackoff({ maxAttempts: 3, delay: 100 });
    const strategy = factory();
    const error = new UPPError('invalid', ErrorCode.InvalidRequest, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBeNull();
  });

  test('factory creates isolated instances', () => {
    const factory = linearBackoff({ maxAttempts: 3, delay: 100 });
    const strategy1 = factory();
    const strategy2 = factory();

    expect(strategy1).not.toBe(strategy2);
  });

  test('exposes maxAttempts property', () => {
    const factory = linearBackoff({ maxAttempts: 4 });
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(4);
  });

  test('maxAttempts defaults to 3', () => {
    const factory = linearBackoff();
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(3);
  });
});

describe('noRetry', () => {
  test('disables retry attempts', () => {
    const factory = noRetry();
    const strategy = factory();
    const error = new UPPError('timeout', ErrorCode.Timeout, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBeNull();
  });

  test('factory creates isolated instances', () => {
    const factory = noRetry();
    const strategy1 = factory();
    const strategy2 = factory();

    expect(strategy1).not.toBe(strategy2);
  });

  test('exposes maxAttempts as 0', () => {
    const factory = noRetry();
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(0);
  });
});

describe('retryAfterStrategy', () => {
  test('uses fallback delay when no Retry-After set', () => {
    const factory = retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 1000 });
    const strategy = factory();
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(1000);
  });

  test('uses Retry-After value when set', () => {
    const factory = retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 1000 });
    const strategy = factory();
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    strategy.setRetryAfter?.(5);
    expect(strategy.onRetry(error, 1)).toBe(5000);
    expect(strategy.onRetry(error, 2)).toBe(1000);
  });

  test('only retries on rate limit errors', () => {
    const factory = retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 1000 });
    const strategy = factory();
    const error = new UPPError('timeout', ErrorCode.Timeout, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBeNull();
  });

  test('respects max attempts', () => {
    const factory = retryAfterStrategy({ maxAttempts: 2, fallbackDelay: 1000 });
    const strategy = factory();
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    expect(strategy.onRetry(error, 1)).toBe(1000);
    expect(strategy.onRetry(error, 2)).toBe(1000);
    expect(strategy.onRetry(error, 3)).toBeNull();
  });

  test('factory creates isolated instances with separate state', () => {
    const factory = retryAfterStrategy({ maxAttempts: 1, fallbackDelay: 1000 });
    const strategy1 = factory();
    const strategy2 = factory();

    strategy1.setRetryAfter?.(2);

    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);
    expect(strategy1.onRetry(error, 1)).toBe(2000);
    expect(strategy2.onRetry(error, 1)).toBe(1000);
  });

  test('exposes maxAttempts property', () => {
    const factory = retryAfterStrategy({ maxAttempts: 5 });
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(5);
  });

  test('maxAttempts defaults to 3', () => {
    const factory = retryAfterStrategy();
    const strategy = factory();

    expect(strategy.maxAttempts).toBe(3);
  });
});

describe('retry strategy isolation', () => {
  test('concurrent requests get independent strategy instances', async () => {
    const factory = retryAfterStrategy({ maxAttempts: 3, fallbackDelay: 500 });
    const error = new UPPError('rate limit', ErrorCode.RateLimited, 'mock', ModalityType.LLM);

    const request1Strategy = factory();
    const request2Strategy = factory();

    request1Strategy.setRetryAfter?.(10);

    expect(request1Strategy.onRetry(error, 1)).toBe(10000);
    expect(request2Strategy.onRetry(error, 1)).toBe(500);
  });
});
