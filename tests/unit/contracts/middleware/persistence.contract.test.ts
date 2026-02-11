import { describe, expect, test } from 'bun:test';
import {
  getThread,
  getThreadId,
  PersistenceAdapter,
  persistenceMiddleware,
} from '../../../../src/middleware/persistence.ts';
import { createMiddlewareContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { AssistantMessage, UserMessage } from '../../../../src/types/messages.ts';
import { Thread } from '../../../../src/types/thread.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';

function createLLMRequest(messages: LLMRequest['messages']): LLMRequest {
  return {
    messages,
    config: {} as LLMRequest['config'],
  };
}

describe('Persistence middleware contracts', () => {
  test('loads persisted thread JSON and prepends only missing messages', async () => {
    const persisted = new Thread([
      new UserMessage('Persisted prompt'),
      new AssistantMessage('Persisted response'),
    ]);

    const adapter = new PersistenceAdapter({
      id: 'thread-load',
      load: async () => persisted.toJSON(),
      save: async () => {},
    });

    const middleware = persistenceMiddleware({ adapter });
    const request = createLLMRequest([
      persisted.messages[0]!,
      new UserMessage('New question'),
    ]);
    const context = createMiddlewareContext('llm', 'mock-model', 'mock-provider', false, request);

    await middleware.onRequest?.(context);

    const merged = (context.request as LLMRequest).messages;
    expect(merged).toHaveLength(3);
    expect(merged[0]?.id).toBe(persisted.messages[0]?.id);
    expect(merged[1]?.id).toBe(persisted.messages[1]?.id);

    expect(getThreadId(context.state)).toBe('thread-load');
    expect(getThread(context.state)?.messages).toHaveLength(2);
  });

  test('preserves persisted chronology and marks turn start after persisted history', async () => {
    const persistedUser = new UserMessage('Persisted prompt', { id: 'persisted-user' });
    const persistedAssistant = new AssistantMessage('Persisted response', undefined, { id: 'persisted-assistant' });
    const persisted = new Thread([persistedUser, persistedAssistant]);

    const adapter = new PersistenceAdapter({
      id: 'thread-order',
      load: async () => persisted,
      save: async () => {},
    });

    const middleware = persistenceMiddleware({ adapter });
    const request = createLLMRequest([
      new UserMessage('Caller override', { id: persistedUser.id }),
      new UserMessage('New question'),
      new AssistantMessage('Caller response override', undefined, { id: persistedAssistant.id }),
    ]);
    const context = createMiddlewareContext('llm', 'mock-model', 'mock-provider', false, request);

    await middleware.onRequest?.(context);

    const merged = (context.request as LLMRequest).messages;
    expect(merged).toHaveLength(3);
    expect(merged[0]?.id).toBe(persistedUser.id);
    expect(merged[1]?.id).toBe(persistedAssistant.id);
    expect(merged[2]?.text).toBe('New question');
    expect(merged[0]?.text).toBe('Caller override');
    expect(merged[1]?.text).toBe('Caller response override');
    expect(context.state.get('llm:turnStartIndex')).toBe(2);
  });

  test('merges request history and saves without duplicate message IDs', async () => {
    const persisted = new Thread([new UserMessage('Persisted')]);
    let savedThread: Thread | undefined;
    let saveCalls = 0;

    const adapter = new PersistenceAdapter({
      id: 'thread-save',
      load: async () => persisted,
      save: async (_id, thread) => {
        saveCalls += 1;
        savedThread = thread;
      },
    });

    const middleware = persistenceMiddleware({ adapter });
    const newQuestion = new UserMessage('What changed?');
    const requestHistory = new AssistantMessage('Caller history');
    const request = createLLMRequest([
      persisted.messages[0]!,
      requestHistory,
      newQuestion,
    ]);
    const context = createMiddlewareContext('llm', 'mock-model', 'mock-provider', false, request);

    await middleware.onRequest?.(context);

    const turn = createTurn(
      [newQuestion, new AssistantMessage('Here is the answer.')],
      [],
      emptyUsage(),
      1,
    );
    await middleware.onTurn?.(turn, context);

    expect(saveCalls).toBe(1);
    expect(savedThread).toBeDefined();

    const ids = savedThread?.messages.map((message) => message.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(requestHistory.id);
    expect(ids).toContain(newQuestion.id);
    expect(ids).toContain(turn.response.id);
  });

  test('wraps adapter load/save failures with thread context', async () => {
    const loadFailureAdapter = new PersistenceAdapter({
      id: 'thread-fail-load',
      load: async () => {
        throw new Error('backend down');
      },
      save: async () => {},
    });
    const loadFailureMiddleware = persistenceMiddleware({ adapter: loadFailureAdapter });
    const loadFailureContext = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      false,
      createLLMRequest([new UserMessage('hi')]),
    );

    await expect(loadFailureMiddleware.onRequest?.(loadFailureContext)).rejects.toThrow(
      'Persistence adapter failed to load thread "thread-fail-load": backend down',
    );

    const saveFailureAdapter = new PersistenceAdapter({
      id: 'thread-fail-save',
      load: async () => new Thread(),
      save: async () => {
        throw new Error('cannot write');
      },
    });
    const saveFailureMiddleware = persistenceMiddleware({ adapter: saveFailureAdapter });
    const saveFailureContext = createMiddlewareContext(
      'llm',
      'mock-model',
      'mock-provider',
      false,
      createLLMRequest([new UserMessage('hello')]),
    );
    await saveFailureMiddleware.onRequest?.(saveFailureContext);

    const turn = createTurn(
      [new UserMessage('hello'), new AssistantMessage('world')],
      [],
      emptyUsage(),
      1,
    );

    await expect(saveFailureMiddleware.onTurn?.(turn, saveFailureContext)).rejects.toThrow(
      'Persistence adapter failed to save thread "thread-fail-save": cannot write',
    );
  });
});
