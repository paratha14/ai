/**
 * HTTP utilities module for unified provider protocol.
 *
 * This module provides comprehensive HTTP infrastructure including:
 * - API key management with multiple strategies (round-robin, weighted, dynamic)
 * - Retry strategies (exponential backoff, linear backoff, retry-after, no-retry)
 * - Fetch wrappers with timeout and error normalization
 * - Server-Sent Events (SSE) stream parsing
 * - Standardized error handling and normalization
 *
 * @module http
 */

export {
  resolveApiKey,
  RoundRobinKeys,
  WeightedKeys,
  DynamicKey,
  maskApiKey,
} from './keys.ts';

export {
  exponentialBackoff,
  linearBackoff,
  noRetry,
  retryAfterStrategy,
  type ExponentialBackoffOptions,
  type LinearBackoffOptions,
  type RetryAfterStrategyOptions,
} from './retry.ts';

export { doFetch, doStreamFetch, warnInsecureUrl } from './fetch.ts';

export { parseSSEStream, parseSimpleTextStream } from './sse.ts';

export {
  normalizeHttpError,
  networkError,
  timeoutError,
  cancelledError,
  statusToErrorCode,
} from './errors.ts';
