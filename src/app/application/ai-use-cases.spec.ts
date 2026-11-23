import { DEFAULT_AI_SETTINGS, AiSettings } from '../domain/ai';
import { WorkspaceDocument } from '../domain/models';
import { AiUseCases } from './ai-use-cases';

describe('AiUseCases', () => {
  let calls: { operation: string; payload: Record<string, unknown> }[];
  let polls: unknown[];
  let secrets: string[];
  let documents: WorkspaceDocument[];
  let stored: Map<string, string>;
  let cases: AiUseCases;
  const on: AiSettings = { ...DEFAULT_AI_SETTINGS, enabled: true, effort: 'high' };

  beforeEach(() => {
    calls = [];
    polls = [];
    secrets = [];
    documents = [];
    stored = new Map();
    const api = {
      execute: async <T>(operation: string, payload: Record<string, unknown>): Promise<T> => {
        calls.push({ operation, payload });
        if (operation === 'ai.chat') return { id: 'c1' } as T;
        if (operation === 'ai.poll') return polls.shift() as T;
        if (operation === 'ai.models') return { models: [{ id: 'm1', name: 'One' }] } as T;
        return {} as T;
      },
    };
    const vault = {
      putSecret: async (name: string) => void secrets.push(name),
      removeSecret: async (name: string) => void (secrets = secrets.filter((n) => n !== name)),
      secrets: async () => secrets.map((name) => ({ name, allowedHosts: [] })),
    };
    const repository = {
      documents: async () => [...documents],
      document: async (id: string) => {
        const found = documents.find((document) => document.id === id);
        if (!found) throw new Error('Not found');
        return found;
      },
      save: async (document: WorkspaceDocument) => {
        const saved = { ...document, revision: document.revision + 1 };
        documents = [...documents.filter((d) => d.id !== document.id), saved];
        return saved;
      },
      remove: async (document: WorkspaceDocument) =>
        void (documents = documents.filter((d) => d.id !== document.id)),
    };
    const preferences = {
      read: (key: string) => stored.get(key),
      write: (key: string, value: string) => void stored.set(key, value),
    };
    cases = new AiUseCases(api as never, vault, preferences, repository, () => Promise.resolve());
  });

  it('keeps its settings on the device and the key in the vault', async () => {
    expect(cases.settings()).toEqual(DEFAULT_AI_SETTINGS);
    cases.saveSettings(on);
    expect(cases.settings()).toEqual(on);
    expect(await cases.hasKey('anthropic')).toBe(false);
    await cases.saveKey('anthropic', ' sk-1 ');
    expect(await cases.hasKey('anthropic')).toBe(true);
    await cases.removeKey('anthropic');
    expect(secrets).toEqual([]);
  });

  it('lists the models directly or through a proxy profile', async () => {
    expect(await cases.models(on, 'local')).toEqual([{ id: 'm1', name: 'One' }]);
    expect(calls[0]).toEqual({
      operation: 'ai.models',
      payload: { workspace: 'local', provider: 'anthropic' },
    });
    documents.push({
      id: 'p1',
      workspace_id: 'local',
      kind: 'proxy-profile',
      name: 'Office',
      revision: 1,
      updated_at: 0,
      value: { protocol: 'http', host: 'proxy.lan' },
    });
    const compatible: AiSettings = {
      ...on,
      provider: 'compatible',
      baseUrl: 'http://h/v1',
      proxy: 'p1',
    };
    await cases.models(compatible, 'local');
    expect(calls[1].payload).toEqual({
      workspace: 'local',
      provider: 'compatible',
      baseUrl: 'http://h/v1',
      route: { via: 'http', profile: 'p1' },
    });
    // A profile that no longer exists: directly.
    await cases.models({ ...on, proxy: 'gone' }, 'local');
    expect(calls[2].payload['route']).toBeUndefined();
  });

  it('streams an answer by polls and says how it ended', async () => {
    polls.push(
      { text: 'Hel', next: 3, done: false },
      { text: '', next: 3, done: false },
      { text: 'lo', next: 5, done: true, stop: 'end_turn' },
    );
    const written: string[] = [];
    const answer = await cases.ask(
      on,
      'local',
      'sql',
      [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: '', failed: 'Network' },
        { role: 'user', text: 'Again' },
      ],
      (text) => written.push(text),
    );
    expect(await answer.done).toEqual({ role: 'assistant', text: 'Hello' });
    expect(written).toEqual(['Hel', 'Hello']);
    const chat = calls.find((call) => call.operation === 'ai.chat')!.payload;
    expect(chat['effort']).toBe('high');
    expect(chat['model']).toBe('claude-opus-5-5');
    expect(chat['messages']).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'user', text: 'Again' },
    ]);
    expect(String(chat['system'])).toContain('SQL');
    expect(
      calls.filter((call) => call.operation === 'ai.poll').map((call) => call.payload),
    ).toEqual([
      { id: 'c1', after: 0 },
      { id: 'c1', after: 3 },
      { id: 'c1', after: 3 },
    ]);
  });

  it('stops an answer once and reports why one failed', async () => {
    polls.push(
      { text: 'One', next: 3, done: false },
      { text: '', next: 3, done: true, stop: 'stopped' },
    );
    const answer = await cases.ask(
      { ...on, provider: 'openai' },
      'local',
      'request',
      [{ role: 'user', text: 'Hi' }],
      () => undefined,
    );
    answer.stop();
    answer.stop();
    expect(await answer.done).toEqual({ role: 'assistant', text: 'One', stop: 'stopped' });
    expect(calls.filter((call) => call.operation === 'ai.stop')).toEqual([
      { operation: 'ai.stop', payload: { id: 'c1' } },
    ]);
    expect(calls.find((call) => call.operation === 'ai.chat')!.payload['effort']).toBeUndefined();
    polls.push({ text: '', next: 0, done: true, error: 'The provider refused the API key' });
    const failed = await cases.ask(
      on,
      'local',
      'mongo',
      [{ role: 'user', text: 'Hi' }],
      () => undefined,
    );
    expect(await failed.done).toEqual({
      role: 'assistant',
      text: '',
      failed: 'The provider refused the API key',
    });
  });

  it('keeps conversations in the workspace, named by their first question', async () => {
    const saved = await cases.save('local', {
      id: 'c1',
      place: 'sql',
      messages: [
        { role: 'user', text: 'Why is this slow?' },
        { role: 'assistant', text: 'Because' },
      ],
    });
    expect(saved).toEqual({ id: 'c1', revision: 1 });
    expect(documents[0]).toMatchObject({ kind: 'ai-conversation', name: 'Why is this slow?' });
    await cases.save('local', { id: 'c2', place: 'request', messages: [] });
    expect(documents.find((d) => d.id === 'c2')!.name).toBe('Conversation');
    documents.push({
      id: 'x',
      workspace_id: 'local',
      kind: 'sql-script',
      name: 'x',
      revision: 1,
      updated_at: 0,
      value: {},
    });
    documents = documents.map((d, at) => ({ ...d, updated_at: at }));
    expect(await cases.conversations('local')).toEqual([
      { id: 'c2', title: 'Conversation' },
      { id: 'c1', title: 'Why is this slow?' },
    ]);
    expect(await cases.conversation('c1')).toMatchObject({ id: 'c1', revision: 1, place: 'sql' });
    const long = Array.from({ length: 205 }, (_, at) => ({
      role: 'user' as const,
      text: `q${at}`,
    }));
    await cases.save('local', { id: 'c3', title: 'Long', place: 'sql', messages: long });
    const kept = documents.find((d) => d.id === 'c3')!.value as { messages: unknown[] };
    expect(kept.messages).toHaveLength(200);
    await cases.remove('local', 'c1', 1);
    expect(documents.some((d) => d.id === 'c1')).toBe(false);
  });
});
