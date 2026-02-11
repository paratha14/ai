import { describe, expect, test } from 'bun:test';
import { embedding } from '../../../../src/core/embedding.ts';
import { image } from '../../../../src/core/image.ts';
import { ErrorCode, ModalityType, UPPError } from '../../../../src/types/errors.ts';
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

interface ProviderModalityCase {
  providerName: string;
  modelId: string;
  supportsEmbedding: boolean;
  supportsImage: boolean;
  createModelReference: () => ProviderModelReference;
}

const proxyProvider = proxy({ endpoint: 'http://localhost:3000/proxy' });

const modalityCases: ProviderModalityCase[] = [
  {
    providerName: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    supportsEmbedding: false,
    supportsImage: false,
    createModelReference: () => anthropic('claude-sonnet-4-20250514'),
  },
  {
    providerName: 'openai',
    modelId: 'gpt-4o-mini',
    supportsEmbedding: true,
    supportsImage: true,
    createModelReference: () => openai('gpt-4o-mini'),
  },
  {
    providerName: 'google',
    modelId: 'gemini-2.0-flash',
    supportsEmbedding: true,
    supportsImage: true,
    createModelReference: () => google('gemini-2.0-flash'),
  },
  {
    providerName: 'openrouter',
    modelId: 'openai/gpt-4o-mini',
    supportsEmbedding: true,
    supportsImage: false,
    createModelReference: () => openrouter('openai/gpt-4o-mini'),
  },
  {
    providerName: 'xai',
    modelId: 'grok-4',
    supportsEmbedding: false,
    supportsImage: true,
    createModelReference: () => xai('grok-4'),
  },
  {
    providerName: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    supportsEmbedding: false,
    supportsImage: false,
    createModelReference: () => groq('llama-3.3-70b-versatile'),
  },
  {
    providerName: 'cerebras',
    modelId: 'llama-3.3-70b',
    supportsEmbedding: false,
    supportsImage: false,
    createModelReference: () => cerebras('llama-3.3-70b'),
  },
  {
    providerName: 'moonshot',
    modelId: 'kimi-k2.5',
    supportsEmbedding: false,
    supportsImage: false,
    createModelReference: () => moonshot('kimi-k2.5'),
  },
  {
    providerName: 'responses',
    modelId: 'gpt-4.1-mini',
    supportsEmbedding: false,
    supportsImage: false,
    createModelReference: () => responses('gpt-4.1-mini', { host: 'http://localhost:3000/v1' }),
  },
  {
    providerName: 'proxy',
    modelId: 'default',
    supportsEmbedding: true,
    supportsImage: true,
    createModelReference: () => proxyProvider('default'),
  },
  {
    providerName: 'ollama',
    modelId: 'llama3.2',
    supportsEmbedding: true,
    supportsImage: false,
    createModelReference: () => ollama('llama3.2'),
  },
];

describe('Embedding and image contracts', () => {
  test('embedding() follows provider support matrix', () => {
    for (const providerCase of modalityCases) {
      const modelReference = providerCase.createModelReference();

      if (providerCase.supportsEmbedding) {
        const instance = embedding({
          model: modelReference,
        });

        expect(instance.model.modelId).toBe(providerCase.modelId);
        expect(instance.model.provider.name).toBe(providerCase.providerName);
        expect(typeof instance.embed).toBe('function');
        continue;
      }

      let error: unknown;
      try {
        embedding({
          model: modelReference,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UPPError);
      expect(error).toMatchObject({
        code: ErrorCode.InvalidRequest,
        modality: ModalityType.Embedding,
        provider: providerCase.providerName,
      });
    }
  });

  test('image() follows provider support matrix', () => {
    for (const providerCase of modalityCases) {
      const modelReference = providerCase.createModelReference();

      if (providerCase.supportsImage) {
        const instance = image({
          model: modelReference,
        });

        expect(instance.model.modelId).toBe(providerCase.modelId);
        expect(instance.model.provider.name).toBe(providerCase.providerName);
        expect(typeof instance.generate).toBe('function');
        continue;
      }

      let error: unknown;
      try {
        image({
          model: modelReference,
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UPPError);
      expect(error).toMatchObject({
        code: ErrorCode.InvalidRequest,
        modality: ModalityType.Image,
        provider: providerCase.providerName,
      });
    }
  });
});
