import { describe, expect, spyOn, test } from 'bun:test';
import {
  exponentialBackoff,
  linearBackoff,
  noRetry,
  retryAfterStrategy,
} from '../../../../src/http/retry.ts';
import { ErrorCode, ModalityType, UPPError } from '../../../../src/types/errors.ts';

type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

function createError(code: ErrorCodeValue): UPPError {
  return new UPPError(`mock-${code}`, code, 'mock', ModalityType.LLM);
}

describe('Retry strategy contracts', () => {
  test('exponentialBackoff applies retryable-code gating, exponential growth, and max bounds', () => {
    const strategy = exponentialBackoff({
      maxAttempts: 4,
      baseDelay: 125,
      maxDelay: 500,
      jitter: false,
    })();

    const retryableCodes = [
      ErrorCode.RateLimited,
      ErrorCode.NetworkError,
      ErrorCode.Timeout,
      ErrorCode.ProviderError,
    ];

    for (const code of retryableCodes) {
      expect(strategy.onRetry(createError(code), 1)).toBe(125);
    }

    expect(strategy.onRetry(createError(ErrorCode.InvalidRequest), 1)).toBeNull();
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 1)).toBe(125);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 2)).toBe(250);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 3)).toBe(500);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 4)).toBe(500);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 5)).toBeNull();
  });

  test('exponentialBackoff jitter is deterministic with mocked randomness', () => {
    const randomSpy = spyOn(Math, 'random');
    randomSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);

    const strategy = exponentialBackoff({
      maxAttempts: 2,
      baseDelay: 1000,
      maxDelay: 10000,
      jitter: true,
    })();

    expect(strategy.onRetry(createError(ErrorCode.RateLimited), 1)).toBe(500);
    expect(strategy.onRetry(createError(ErrorCode.RateLimited), 1)).toBe(1499);

    randomSpy.mockRestore();
  });

  test('exponentialBackoff clamps very large attempts by maxDelay', () => {
    const strategy = exponentialBackoff({
      maxAttempts: 100,
      baseDelay: 1000,
      maxDelay: 60000,
      jitter: false,
    })();

    expect(strategy.onRetry(createError(ErrorCode.Timeout), 50)).toBe(60000);
  });

  test('linearBackoff applies linear math, retryable-code gating, and maxAttempts bound', () => {
    const strategy = linearBackoff({
      maxAttempts: 3,
      delay: 250,
    })();

    expect(strategy.onRetry(createError(ErrorCode.Timeout), 1)).toBe(250);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 2)).toBe(500);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 3)).toBe(750);
    expect(strategy.onRetry(createError(ErrorCode.Timeout), 4)).toBeNull();
    expect(strategy.onRetry(createError(ErrorCode.InvalidRequest), 1)).toBeNull();
  });

  test('retryAfterStrategy honors Retry-After once, falls back, and isolates factory state', () => {
    const factory = retryAfterStrategy({
      maxAttempts: 3,
      fallbackDelay: 800,
    });
    const strategyA = factory();
    const strategyB = factory();
    const rateLimitedError = createError(ErrorCode.RateLimited);

    strategyA.setRetryAfter?.(4);

    expect(strategyA.onRetry(rateLimitedError, 1)).toBe(4000);
    expect(strategyA.onRetry(rateLimitedError, 2)).toBe(800);
    expect(strategyA.onRetry(createError(ErrorCode.Timeout), 2)).toBeNull();
    expect(strategyA.onRetry(rateLimitedError, 4)).toBeNull();

    expect(strategyB.onRetry(rateLimitedError, 1)).toBe(800);
  });

  test('noRetry never schedules retries and exposes zero maxAttempts', () => {
    const strategy = noRetry()();

    expect(strategy.maxAttempts).toBe(0);
    expect(strategy.onRetry(createError(ErrorCode.RateLimited), 1)).toBeNull();
    expect(strategy.onRetry(createError(ErrorCode.ProviderError), 1)).toBeNull();
  });
});
