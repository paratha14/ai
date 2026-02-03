/**
 * @fileoverview Zod schema utilities for structured output.
 *
 * Provides detection and conversion utilities for Zod schemas,
 * supporting both Zod v3 and v4 schemas.
 *
 * @module utils/zod
 */

import type { JSONSchema, ZodLike, ZodV3Like, ZodV4Like } from '../types/schema.ts';
import type { Tool, ToolInput } from '../types/tool.ts';
import type * as Zod from 'zod';
import type { zodToJsonSchema as ZodToJsonSchemaFn } from 'zod-to-json-schema';

/** Cached Zod module for sync access */
let cachedZod: typeof Zod | undefined;

/** Cached zod-to-json-schema module for sync access */
let cachedZodToJsonSchema: { zodToJsonSchema: typeof ZodToJsonSchemaFn } | undefined;

// Pre-load modules at import time for sync access
// Uses dynamic import which is ESM-compatible
try {
  cachedZod = await import('zod') as typeof Zod;
} catch {
  // Zod not installed - will throw on use
}

try {
  const mod = await import('zod-to-json-schema');
  cachedZodToJsonSchema = { zodToJsonSchema: mod.zodToJsonSchema as typeof ZodToJsonSchemaFn };
} catch {
  // zod-to-json-schema not installed - will throw on use for v3
}

/**
 * Checks if a value is a Zod schema (v3 or v4).
 *
 * @param value - Value to check
 * @returns True if the value appears to be a Zod schema
 */
export function isZodSchema(value: unknown): value is ZodLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_def' in value &&
    'parse' in value &&
    typeof (value as ZodV3Like).parse === 'function'
  );
}

/**
 * Checks if a Zod schema is v4 or later.
 *
 * @param schema - Zod schema to check
 * @returns True if the schema is Zod v4+
 */
export function isZodV4(schema: ZodLike): schema is ZodV4Like {
  return '_zod' in schema;
}

/**
 * Loads and caches the Zod module.
 */
async function loadZod(): Promise<typeof Zod> {
  if (!cachedZod) {
    cachedZod = await import('zod') as typeof Zod;
  }
  return cachedZod;
}

/**
 * Loads and caches the zod-to-json-schema module.
 */
async function loadZodToJsonSchema(): Promise<{ zodToJsonSchema: typeof ZodToJsonSchemaFn }> {
  if (!cachedZodToJsonSchema) {
    const mod = await import('zod-to-json-schema');
    cachedZodToJsonSchema = { zodToJsonSchema: mod.zodToJsonSchema as typeof ZodToJsonSchemaFn };
  }
  return cachedZodToJsonSchema;
}

/**
 * Converts a Zod v4 schema to JSON Schema using native conversion.
 */
async function zodV4ToJSONSchema(schema: ZodV4Like): Promise<JSONSchema> {
  const z = await loadZod();
  if (!('toJSONSchema' in z)) {
    throw new Error(
      'Zod v4+ required for native JSON Schema conversion. ' +
      'Install with: bun add zod@latest',
    );
  }
  const jsonSchema = z.toJSONSchema(schema as Zod.ZodType, { target: 'draft-07' });
  return jsonSchema as JSONSchema;
}

/**
 * Synchronous version for v4 schemas.
 * Requires Zod to be cached via prior async load.
 */
function zodV4ToJSONSchemaSync(schema: ZodV4Like): JSONSchema {
  if (!cachedZod) {
    throw new Error(
      'Zod module not loaded. Call zodToJSONSchema() first or ensure Zod is imported.',
    );
  }
  if (!('toJSONSchema' in cachedZod)) {
    throw new Error(
      'Zod v4+ required for native JSON Schema conversion. ' +
      'Install with: bun add zod@latest',
    );
  }
  const jsonSchema = cachedZod.toJSONSchema(schema as Zod.ZodType, { target: 'draft-07' });
  return jsonSchema as JSONSchema;
}

/**
 * Converts a Zod v3 schema to JSON Schema using zod-to-json-schema.
 * Uses inline strategy to keep properties at root level for provider compatibility.
 */
async function zodV3ToJSONSchema(
  schema: ZodV3Like,
): Promise<JSONSchema> {
  const { zodToJsonSchema } = await loadZodToJsonSchema();
  const jsonSchema = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    $refStrategy: 'none',
  });
  return jsonSchema as unknown as JSONSchema;
}

/**
 * Synchronous version for v3 schemas.
 * Requires zod-to-json-schema to be cached via prior async load.
 */
function zodV3ToJSONSchemaSync(schema: ZodV3Like): JSONSchema {
  if (!cachedZodToJsonSchema) {
    throw new Error(
      'zod-to-json-schema module not loaded. Call zodToJSONSchema() first.',
    );
  }
  const jsonSchema = cachedZodToJsonSchema.zodToJsonSchema(
    schema as Parameters<typeof ZodToJsonSchemaFn>[0],
    {
      $refStrategy: 'none',
    },
  );
  return jsonSchema as unknown as JSONSchema;
}

/**
 * Converts a Zod schema to JSON Schema.
 *
 * For Zod v4+, uses native `z.toJSONSchema()`.
 * For Zod v3, uses `zod-to-json-schema` package.
 *
 * @param schema - Zod schema to convert
 * @returns JSON Schema representation
 * @throws Error if required dependencies are not installed
 */
export async function zodToJSONSchema(
  schema: ZodLike,
): Promise<JSONSchema> {
  if (isZodV4(schema)) {
    return zodV4ToJSONSchema(schema);
  }
  return zodV3ToJSONSchema(schema);
}

/**
 * Synchronous version of zodToJSONSchema.
 * Requires modules to be cached via prior async load.
 *
 * @param schema - Zod schema to convert
 * @returns JSON Schema representation
 * @throws Error if modules not loaded or dependencies missing
 */
export function zodToJSONSchemaSync(
  schema: ZodLike,
): JSONSchema {
  if (isZodV4(schema)) {
    return zodV4ToJSONSchemaSync(schema);
  }
  return zodV3ToJSONSchemaSync(schema);
}

/**
 * Validates that a schema is an object schema with properties.
 * Throws if the schema is not a valid object schema.
 */
function validateObjectSchema(schema: unknown, context: string): asserts schema is JSONSchema {
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || typeof s.properties !== 'object' || s.properties === null) {
    throw new Error(
      `${context} must be an object schema with properties. ` +
      `Received schema with type: '${s.type ?? 'undefined'}'. ` +
      'Use z.object({...}) for Zod schemas.',
    );
  }
}

/**
 * Resolves a structure parameter that may be JSONSchema or Zod schema.
 * Validates that the result is an object schema.
 *
 * @param structure - JSONSchema or Zod schema (must be object type)
 * @returns Resolved JSONSchema
 * @throws Error if schema is not an object type
 */
export function resolveStructure(
  structure: JSONSchema | ZodLike,
): JSONSchema {
  if (isZodSchema(structure)) {
    const schema = zodToJSONSchemaSync(structure);
    validateObjectSchema(schema, 'Structure schema');
    return schema;
  }
  return structure;
}

/**
 * Resolves an array of tools, converting any Zod parameters to JSONSchema.
 * Validates that each tool's parameters is an object schema.
 *
 * @param tools - Array of tools with Structure parameters
 * @returns Array of tools with resolved JSONSchema parameters
 * @throws Error if any tool parameters is not an object schema
 */
export function resolveTools(tools: ToolInput[]): Tool[] {
  return tools.map((tool) => {
    if (isZodSchema(tool.parameters)) {
      const schema = zodToJSONSchemaSync(tool.parameters);
      validateObjectSchema(schema, `Tool '${tool.name}' parameters`);
      return { ...tool, parameters: schema };
    }
    return tool as Tool;
  });
}
