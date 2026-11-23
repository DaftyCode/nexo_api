import { AiSettings, DEFAULT_AI_SETTINGS } from '../domain/ai';
import { AiUseCases, AiWritten } from './ai-use-cases';

/**
 * Answers streamed by polls: their text, their reasoning apart, the tools they read with, a
 * stop and a failure.
 */
describe('AiUseCases answers', () => {
  let calls: { operation: string; payload: Record<string, unknown> }[];
  let polls: unknown[];
  let clock: number;
  let cases: AiUseCases;
  const on: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    enabled: true,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    effort: 'high',
  };

  beforeEach(() => {
    calls = [];
    polls = [];
    clock = 0;
    const api = {
      execute: async <T>(operation: string, payload: Record<string, unknown>): Promise<T> => {
        calls.push({ operation, payload });
        if (operation === 'ai.chat') return { id: 'c1' } as T;
        if (operation === 'ai.poll') return polls.shift() as T;
        if (operation === 'ai.tool' && payload['name'] === 'sql_query') {
          throw new Error('Prod is not exposed to MCP');
        }
        if (operation === 'ai.tool') return { text: `read ${String(payload['name'])}` } as T;
        return {} as T;
      },
    };
    const none = async () => [];
    cases = new AiUseCases(
      api as never,
      { putSecret: none, removeSecret: none, secrets: none } as never,
      { read: () => undefined, write: () => undefined },
      { documents: none, document: none, save: none, remove: none } as never,
      () => Promise.resolve(),
      () => (clock += 1500),
    );
  });

  it('streams an answer by polls and says how it ended', async () => {
    polls.push(
      { text: 'Hel', next: 3, done: false },
      { text: '', next: 3, done: false },
      { text: 'lo', next: 5, done: true, stop: 'end_turn' },
    );
    const written: AiWritten[] = [];
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
    expect(written).toEqual([
      { text: 'Hel', thinking: '', steps: [] },
      { text: 'Hello', thinking: '', steps: [] },
    ]);
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
      { id: 'c1', after: 0, thinkingAfter: 0 },
      { id: 'c1', after: 3, thinkingAfter: 0 },
      { id: 'c1', after: 3, thinkingAfter: 0 },
    ]);
  });

  it('shows the reasoning apart, says how long it took and never sends it back', async () => {
    polls.push(
      { text: '', next: 0, thinking: 'Count by', thinkingNext: 8, done: false },
      { text: '', next: 0, thinking: ' client.', thinkingNext: 16, done: false },
      { text: 'GROUP BY', next: 8, thinking: '', thinkingNext: 16, done: true, stop: 'stop' },
    );
    const written: AiWritten[] = [];
    const answer = await cases.ask(
      { ...on, provider: 'local', model: 'local' },
      'local',
      'sql',
      [
        { role: 'user', text: 'Count' },
        { role: 'assistant', text: 'Sure', thinking: 'Earlier', thought: 3 },
        { role: 'user', text: 'Again' },
      ],
      (text) => written.push(text),
    );
    // Its reasoning began at 1.5 s and its answer at 3 s.
    expect(await answer.done).toEqual({
      role: 'assistant',
      text: 'GROUP BY',
      thinking: 'Count by client.',
      thought: 2,
    });
    expect(written.map((part) => part.thinking)).toEqual([
      'Count by',
      'Count by client.',
      'Count by client.',
    ]);
    expect(calls.find((call) => call.operation === 'ai.chat')!.payload['messages']).toEqual([
      { role: 'user', text: 'Count' },
      { role: 'assistant', text: 'Sure' },
      { role: 'user', text: 'Again' },
    ]);
    expect(
      calls.filter((call) => call.operation === 'ai.poll').map((call) => call.payload),
    ).toEqual([
      { id: 'c1', after: 0, thinkingAfter: 0 },
      { id: 'c1', after: 0, thinkingAfter: 8 },
      { id: 'c1', after: 0, thinkingAfter: 16 },
    ]);
    // Stopped while it still reasoned: what it reasoned is kept.
    polls.push({
      text: '',
      next: 0,
      thinking: 'Hmm',
      thinkingNext: 3,
      done: true,
      stop: 'stopped',
    });
    const stopped = await cases.ask(on, 'local', 'sql', [{ role: 'user', text: 'Hi' }], () => {});
    expect(await stopped.done).toMatchObject({ text: '', thinking: 'Hmm', thought: 2 });
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

  it('reads with the tools the model asks for and gives their answers back', async () => {
    polls.push(
      {
        text: 'Let me look.',
        next: 12,
        done: false,
        tools: [
          { id: 't1', name: 'read_open', input: {} },
          { id: 't2', name: 'sql_query', input: { connection: 'Prod', sql: 'SELECT 1' } },
        ],
      },
      { text: ' It counts.', next: 23, done: true, stop: 'end_turn' },
    );
    const written: AiWritten[] = [];
    const answer = await cases.ask(
      on,
      'local',
      'sql',
      [{ role: 'user', text: 'Count' }],
      (part) => written.push(part),
      () => ({ place: 'sql', script: 'SELECT 1' }),
    );
    expect(await answer.done).toEqual({
      role: 'assistant',
      text: 'Let me look. It counts.',
      steps: [{ tool: 'read_open' }, { tool: 'sql_query', detail: 'Prod', failed: true }],
    });
    expect(calls.find((call) => call.operation === 'ai.chat')!.payload['tools']).toBe('sql');
    expect(
      calls.filter((call) => call.operation === 'ai.tool').map((call) => call.payload),
    ).toEqual([
      {
        workspace: 'local',
        name: 'read_open',
        input: {},
        context: { place: 'sql', script: 'SELECT 1' },
        bodies: true,
      },
      {
        workspace: 'local',
        name: 'sql_query',
        input: { connection: 'Prod', sql: 'SELECT 1' },
        context: { place: 'sql', script: 'SELECT 1' },
        bodies: true,
      },
    ]);
    expect(calls.find((call) => call.operation === 'ai.continue')!.payload).toEqual({
      id: 'c1',
      results: [
        { id: 't1', text: 'read read_open' },
        { id: 't2', text: 'Prod is not exposed to MCP', error: true },
      ],
    });
    // Each step shows as it starts, and how it went once every tool answered.
    expect(written.map((part) => part.steps.length)).toEqual([0, 1, 2, 2, 2]);
    expect(written[3]!.steps[1]).toEqual({ tool: 'sql_query', detail: 'Prod', failed: true });

    // Bodies kept home, nothing open and input that is not an object.
    polls.push(
      { text: '', next: 0, done: false, tools: [{ id: 't3', name: 'read_response', input: 'x' }] },
      { text: 'Done', next: 4, done: true },
    );
    const kept = await cases.ask({ ...on, bodies: false }, 'local', 'request', [], () => {});
    await kept.done;
    expect(calls.filter((call) => call.operation === 'ai.tool').at(-1)!.payload).toEqual({
      workspace: 'local',
      name: 'read_response',
      input: {},
      bodies: false,
    });
    // A model that ends without a word says so.
    polls.push({ text: ' ', next: 1, done: true, stop: 'stop' });
    const silent = await cases.ask(on, 'local', 'sql', [], () => {});
    expect(await silent.done).toMatchObject({ stop: 'empty' });
  });
});
