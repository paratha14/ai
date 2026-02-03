/**
 * Utility functions for UPP
 *
 * Provides helper utilities for working with streaming JSON,
 * Zod schema conversion, and other common operations.
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
