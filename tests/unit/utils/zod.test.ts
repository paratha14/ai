import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import {
  isZodSchema,
  isZodV4,
  zodToJSONSchemaSync,
  resolveStructure,
} from '../../../src/utils/zod.ts';
import type { JSONSchema } from '../../../src/types/schema.ts';

describe('isZodSchema', () => {
  test('returns true for Zod object schema', () => {
    const schema = z.object({ name: z.string() });
    expect(isZodSchema(schema)).toBe(true);
  });

  test('returns true for Zod string schema', () => {
    const schema = z.string();
    expect(isZodSchema(schema)).toBe(true);
  });

  test('returns false for plain object', () => {
    const obj = { name: 'test' };
    expect(isZodSchema(obj)).toBe(false);
  });

  test('returns false for null', () => {
    expect(isZodSchema(null)).toBe(false);
  });

  test('returns false for JSONSchema', () => {
    const jsonSchema: JSONSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(isZodSchema(jsonSchema)).toBe(false);
  });
});

describe('isZodV4', () => {
  test('returns true for Zod v4 schema', () => {
    const schema = z.object({ name: z.string() });
    expect(isZodV4(schema)).toBe(true);
  });
});

describe('zodToJSONSchemaSync', () => {
  test('converts simple object schema', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });

    const jsonSchema = zodToJSONSchemaSync(schema);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties).toBeDefined();
    expect(jsonSchema.properties.name).toBeDefined();
    expect(jsonSchema.properties.age).toBeDefined();
  });

  test('converts schema with optional fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const jsonSchema = zodToJSONSchemaSync(schema);

    expect(jsonSchema.required).toContain('required');
  });

  test('converts nested object schema', () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
      }),
    });

    const jsonSchema = zodToJSONSchemaSync(schema);

    expect(jsonSchema.properties.user).toBeDefined();
  });

  test('converts array schema', () => {
    const schema = z.object({
      items: z.array(z.string()),
    });

    const jsonSchema = zodToJSONSchemaSync(schema);

    expect(jsonSchema.properties.items).toBeDefined();
  });
});

describe('resolveStructure', () => {
  test('passes through JSONSchema unchanged', () => {
    const jsonSchema: JSONSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };

    const result = resolveStructure(jsonSchema);

    expect(result).toBe(jsonSchema);
  });

  test('converts Zod schema to JSONSchema', () => {
    const zodSchema = z.object({
      name: z.string(),
    });

    const result = resolveStructure(zodSchema);

    expect(result.type).toBe('object');
    expect(result.properties).toBeDefined();
    expect(result.properties.name).toBeDefined();
  });

  test('throws for non-object Zod schema (string)', () => {
    const stringSchema = z.string();

    expect(() => resolveStructure(stringSchema)).toThrow(
      /must be an object schema/,
    );
  });

  test('throws for non-object Zod schema (number)', () => {
    const numberSchema = z.number();

    expect(() => resolveStructure(numberSchema)).toThrow(
      /must be an object schema/,
    );
  });

  test('throws for non-object Zod schema (array)', () => {
    const arraySchema = z.array(z.string());

    expect(() => resolveStructure(arraySchema)).toThrow(
      /must be an object schema/,
    );
  });
});
