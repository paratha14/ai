/**
 * Utility functions for UPP
 *
 * Provides helper utilities for working with streaming JSON,
 * Zod schema conversion, error handling, and ID generation.
 *
 * @packageDocumentation
 */

export { parsePartialJson } from './partial-json.ts';
export type { PartialParseResult } from './partial-json.ts';

export {
  isZodSchema,
  isZodV4,
  zodToJSONSchema,
  zodToJSONSchemaSync,
  resolveStructure,
  resolveTools,
} from './zod.ts';

export { toError, isCancelledError } from './error.ts';

export { generateId, generateShortId } from './id.ts';
