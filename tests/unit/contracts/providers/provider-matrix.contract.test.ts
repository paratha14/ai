import { describe, expect, test } from 'bun:test';
import { llm } from '../../../../src/core/llm.ts';
import { anthropic } from '../../../../src/anthropic/index.ts';
import { openai } from '../../../../src/openai/index.ts';
import { google } from '../../../../src/google/index.ts';
import { openrouter } from '../../../../src/openrouter/index.ts';
import { xai } from '../../../../src/xai/index.ts';
import { groq } from '../../../../src/groq/index.ts';
import { cerebras } from '../../../../src/cerebras/index.ts';
import { moonshot } from '../../../../src/moonshot/index.ts';
import { responses } from '../../../../src/responses/index.ts';
import { ollama } from '../../../../src/ollama/index.ts';
import { proxy } from '../../../../src/proxy/index.ts';
import type { ProviderConfig, ProviderIdentity } from '../../../../src/types/provider.ts';

interface ProviderModelReference {
  modelId: string;
  provider: ProviderIdentity;
  providerConfig?: Partial<ProviderConfig>;
  options?: unknown;
}

interface LLMProviderCase {
  providerName: string;
  modelId: string;
  createModelReference: () => ProviderModelReference;
}

const proxyProvider = proxy({ endpoint: 'http://localhost:3000/proxy' });

const providerCases: LLMProviderCase[] = [
  {
    providerName: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    createModelReference: () => anthropic('claude-sonnet-4-20250514'),
  },
  {
    providerName: 'openai',
    modelId: 'gpt-4o-mini',
    createModelReference: () => openai('gpt-4o-mini'),
  },
  {
    providerName: 'google',
    modelId: 'gemini-2.0-flash',
    createModelReference: () => google('gemini-2.0-flash'),
  },
  {
    providerName: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    createModelReference: () => openrouter('openai/gpt-4o-mini'),
  },
  {
    providerName: 'xai',
    modelId: 'grok-4',
    createModelReference: () => xai('grok-4'),
  },
  {
    providerName: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    createModelReference: () => groq('llama-3.3-70b-versatile'),
  },
  {
    providerName: 'cerebras',
    modelId: 'llama-3.3-70b',
    createModelReference: () => cerebras('llama-3.3-70b'),
  },
  {
    providerName: 'moonshot',
    modelId: 'kimi-k2.5',
    createModelReference: () => moonshot('kimi-k2.5'),
  },
  {
    providerName: 'responses',
    modelId: 'gpt-4.1-mini',
    createModelReference: () => responses('gpt-4.1-mini', { host: 'http://localhost:3000/v1' }),
  },
  {
    providerName: 'proxy',
    modelId: 'default',
    createModelReference: () => proxyProvider('default'),
  },
  {
    providerName: 'ollama',
    modelId: 'llama3.2',
    createModelReference: () => ollama('llama3.2'),
  },
];

describe('Provider matrix contracts', () => {
  test('creates llm() instances for all provider entrypoints', () => {
    for (const providerCase of providerCases) {
      const modelReference = providerCase.createModelReference();
      const instance = llm({
        model: modelReference,
      });

      expect(instance.model.modelId).toBe(providerCase.modelId);
      expect(instance.model.provider.name).toBe(providerCase.providerName);
      expect(typeof instance.model.provider.version).toBe('string');
      expect(typeof instance.generate).toBe('function');
      expect(typeof instance.stream).toBe('function');
    }
  });

  test('requires a host option for responses model references', () => {
    expect(() => responses('gpt-4.1-mini')).toThrow(
      'OpenResponses provider requires a host option'
    );
  });
});
