/**
 * Retry strategy factories for handling transient failures in HTTP requests.
 *
 * All strategies use the factory pattern to ensure each request gets an
 * isolated instance, preventing state sharing between concurrent requests.
 *
 * @module http/retry
 */

import type { RetryStrategy, RetryStrategyFactory } from '../types/provider.ts';
import { ErrorCode, type UPPError } from '../types/errors.ts';

/**
 * Checks if an error is eligible for retry.
 */
function isRetryable(error: UPPError): boolean {
  return (
    error.code === ErrorCode.RateLimited ||
    error.code === ErrorCode.NetworkError ||
    error.code === ErrorCode.Timeout ||
    error.code === ErrorCode.ProviderError
  );
}

/**
 * Options for exponential backoff retry strategy.
 */
export interface ExponentialBackoffOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 1000) */
  baseDelay?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Whether to add random jitter to delays (default: true) */
  jitter?: boolean;
}

/**
 * Creates an exponential backoff retry strategy.
 *
 * The delay between retries doubles with each attempt, helping to:
 * - Avoid overwhelming servers during outages
 * - Reduce thundering herd effects when many clients retry simultaneously
 * - Give transient issues time to resolve
 *
 * Delay formula: min(baseDelay * 2^(attempt-1), maxDelay)
 * With jitter: delay * random(0.5, 1.0)
 *
 * Only retries on transient errors: RATE_LIMITED, NETWORK_ERROR, TIMEOUT, PROVIDER_ERROR
 *
 * @param options - Configuration options
 * @returns A factory that creates fresh strategy instances per request
 *
 * @example
 * ```typescript
 * // Default configuration (3 retries, 1s base, 30s max, jitter enabled)
 * const retry = exponentialBackoff();
 *
 * // Custom configuration
 * const customRetry = exponentialBackoff({
 *   maxAttempts: 5,     // Up to 5 retry attempts
 *   baseDelay: 500,     // Start with 500ms delay
 *   maxDelay: 60000,    // Cap at 60 seconds
 *   jitter: false       // Disable random jitter
 * });
 *
 * // Use with provider
 * const provider = createOpenAI({
 *   retryStrategy: customRetry
 * });
 * ```
 */
export function exponentialBackoff(options: ExponentialBackoffOptions = {}): RetryStrategyFactory {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 30000;
  const jitter = options.jitter ?? true;

  return (): RetryStrategy => ({
    onRetry(error: UPPError, attempt: number): number | null {
      if (attempt > maxAttempts) {
        return null;
      }

      if (!isRetryable(error)) {
        return null;
      }

      let delay = baseDelay * Math.pow(2, attempt - 1);
      delay = Math.min(delay, maxDelay);

      if (jitter) {
        delay = delay * (0.5 + Math.random());
      }

      return Math.floor(delay);
    },
  });
}

/**
 * Options for linear backoff retry strategy.
 */
export interface LinearBackoffOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay multiplier in milliseconds (default: 1000) */
  delay?: number;
}

/**
 * Creates a linear backoff retry strategy.
 *
 * Unlike exponential backoff, linear backoff increases delays at a constant rate:
 * - Attempt 1: delay * 1 (e.g., 1000ms)
 * - Attempt 2: delay * 2 (e.g., 2000ms)
 * - Attempt 3: delay * 3 (e.g., 3000ms)
 *
 * This strategy is simpler and more predictable than exponential backoff,
 * suitable for scenarios where gradual delay increase is preferred over
 * aggressive backoff.
 *
 * Only retries on transient errors: RATE_LIMITED, NETWORK_ERROR, TIMEOUT, PROVIDER_ERROR
 *
 * @param options - Configuration options
 * @returns A factory that creates fresh strategy instances per request
 *
 * @example
 * ```typescript
 * // Default configuration (3 retries, 1s delay increment)
 * const retry = linearBackoff();
 *
 * // Custom configuration
 * const customRetry = linearBackoff({
 *   maxAttempts: 4,  // Up to 4 retry attempts
 *   delay: 2000      // 2s, 4s, 6s, 8s delays
 * });
 *
 * // Use with provider
 * const provider = createAnthropic({
 *   retryStrategy: customRetry
 * });
 * ```
 */
export function linearBackoff(options: LinearBackoffOptions = {}): RetryStrategyFactory {
  const maxAttempts = options.maxAttempts ?? 3;
  const delay = options.delay ?? 1000;

  return (): RetryStrategy => ({
    onRetry(error: UPPError, attempt: number): number | null {
      if (attempt > maxAttempts) {
        return null;
      }

      if (!isRetryable(error)) {
        return null;
      }

      return delay * attempt;
    },
  });
}

/**
 * Creates a no-retry strategy that fails immediately on any error.
 *
 * Use this strategy when:
 * - Retries are handled at a higher level in your application
 * - You want immediate failure feedback
 * - The operation is not idempotent
 * - Time sensitivity requires fast failure
 *
 * @returns A factory that creates no-retry strategy instances
 *
 * @example
 * ```typescript
 * // Disable retries for time-sensitive operations
 * const provider = createOpenAI({
 *   retryStrategy: noRetry()
 * });
 * ```
 */
export function noRetry(): RetryStrategyFactory {
  return (): RetryStrategy => ({
    onRetry(): null {
      return null;
    },
  });
}

/**
 * Options for retry-after strategy.
 */
export interface RetryAfterStrategyOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Delay in ms when no Retry-After header is present (default: 5000) */
  fallbackDelay?: number;
}

/**
 * Creates a retry strategy that respects server-provided Retry-After headers.
 *
 * When servers return a 429 (Too Many Requests) response, they often include
 * a Retry-After header indicating when the client should retry. This strategy
 * uses that information for precise retry timing.
 *
 * Benefits over fixed backoff strategies:
 * - Follows server recommendations for optimal retry timing
 * - Avoids retrying too early and wasting requests
 * - Adapts to dynamic rate limit windows
 *
 * If no Retry-After header is provided, falls back to a configurable delay.
 * Only retries on RATE_LIMITED errors.
 *
 * @param options - Configuration options
 * @returns A factory that creates fresh strategy instances per request
 *
 * @example
 * ```typescript
 * // Use server-recommended retry timing
 * const retryAfter = retryAfterStrategy({
 *   maxAttempts: 5,       // Retry up to 5 times
 *   fallbackDelay: 10000  // 10s fallback if no header
 * });
 *
 * const provider = createOpenAI({
 *   retryStrategy: retryAfter
 * });
 * ```
 */
export function retryAfterStrategy(options: RetryAfterStrategyOptions = {}): RetryStrategyFactory {
  const maxAttempts = options.maxAttempts ?? 3;
  const fallbackDelay = options.fallbackDelay ?? 5000;

  return (): RetryStrategy => {
    let lastRetryAfter: number | undefined;

    return {
      setRetryAfter(seconds: number): void {
        lastRetryAfter = seconds * 1000;
      },

      onRetry(error: UPPError, attempt: number): number | null {
        if (attempt > maxAttempts) {
          return null;
        }

        if (error.code !== ErrorCode.RateLimited) {
          return null;
        }

        const delay = lastRetryAfter ?? fallbackDelay;
        lastRetryAfter = undefined;
        return delay;
      },
    };
  };
}
