import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiFailure } from '../application/ports';
import { AI } from '../composition/providers';
import { AiUse, DEFAULT_AI_SETTINGS } from '../domain/ai';
import { newRequest } from '../domain/models/items';
import { buttons, clickButton, control, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { AiChat } from './ai-chat';
import { WorkspaceState } from './workspace-state';

describe('AiChat', () => {
  let fixture: ComponentFixture<AiChat>;
  let api: TestApi;
  let state: WorkspaceState;
  let polls: unknown[];
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
  };
  /** Lets the polls of an answer run until `done` holds. */
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) {
      await new Promise((wait) => setTimeout(wait, 2));
      await fixture.whenStable();
    }
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const ask = async (question: string, keys: KeyboardEventInit = { key: 'Enter' }) => {
    await fill(fixture, 'Ask the assistant', question);
    control(root(), 'Ask the assistant').dispatchEvent(
      new KeyboardEvent('keydown', { ...keys, cancelable: true }),
    );
    await settle();
  };
  const create = async (ready = true, place: 'sql' | 'request' | 'mongo' = 'sql') => {
    if (ready) {
      TestBed.inject(AI).saveSettings({
        ...DEFAULT_AI_SETTINGS,
        enabled: true,
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      });
      api.secretNames.push('ai:anthropic');
    }
    fixture = TestBed.createComponent(AiChat);
    fixture.componentRef.setInput('place', place);
    await settle();
  };

  beforeEach(async () => {
    polls = [];
    await TestBed.configureTestingModule({
      providers: testProviders({
        'ai.chat': { id: 'c1' },
        // A macrotask between polls, as the network gives.
        'ai.poll': () => new Promise((done) => setTimeout(() => done(polls.shift()), 0)),
      }),
      imports: [AiChat],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
  });

  it('shows its settings until the assistant is set up', async () => {
    await create(false);
    expect(text()).toContain('The assistant is off');
    expect(text()).toContain('Use the AI assistant');
    expect(root().querySelector('textarea')).toBeNull();
    expect(text()).toContain('Model inside Nexo');
    (control(root(), 'Use the AI assistant') as HTMLInputElement).click();
    await fill(fixture, 'Provider', 'anthropic');
    await settle();
    await fill(fixture, 'API key', 'sk-test');
    await click(/^Save$/);
    await until(() => text().includes('Ask the assistant'));
    expect(text()).toContain('Ask the assistant');
    expect(api.secretNames).toEqual(['ai:anthropic']);
  });

  it('shows again the conversation and the question it had, in another tab', async () => {
    await create();
    polls.push({ text: 'Use an index.', next: 13, done: true, stop: 'end_turn' });
    await ask('Why is it slow?');
    await until(() => text().includes('Use an index.'));
    await fill(fixture, 'Ask the assistant', 'And the plan?');
    fixture.destroy();
    fixture = TestBed.createComponent(AiChat);
    fixture.componentRef.setInput('place', 'sql');
    await settle();
    expect(text()).toContain('Why is it slow?');
    expect(text()).toContain('Use an index.');
    expect((control(root(), 'Ask the assistant') as HTMLTextAreaElement).value).toBe(
      'And the plan?',
    );
    // In another workspace, a new conversation.
    state.workspaceId.set('other');
    await settle();
    expect(root().querySelector('.ai-chat-messages')?.textContent).not.toContain('Why is it slow?');
  });

  it('streams an answer, keeps the conversation and opens it again', async () => {
    await create();
    expect(text()).toContain('Ask anything about your query');
    polls.push(
      { text: 'Use ', next: 4, done: false },
      { text: 'an index.', next: 13, done: true, stop: 'end_turn' },
    );
    // Shift+Enter starts a new line: nothing is sent.
    await ask('Why is this slow?', { key: 'Enter', shiftKey: true });
    expect(api.calls.some((call) => call.operation === 'ai.chat')).toBe(false);
    await ask('Why is this slow?');
    await until(() => api.documentsStore.length > 0);
    expect(text()).toContain('Use an index.');
    const chat = api.calls.find((call) => call.operation === 'ai.chat')!.payload;
    expect(chat['messages']).toEqual([{ role: 'user', text: 'Why is this slow?' }]);
    // The model knows which one it is.
    expect(chat['system']).toContain('The model answering is claude-opus-5-5, from Anthropic');
    const [kept] = api.documentsStore;
    expect(kept).toMatchObject({ kind: 'ai-conversation', name: 'Why is this slow?' });
    expect(text()).toContain('Why is this slow?');

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    });
    await click(/^Copy$/);
    expect(state.toast()).toMatchObject({ title: 'Copied to the clipboard' });

    await click(/^New$/);
    expect(text()).toContain('Ask anything about your query');
    // The list of conversations: a row opens its conversation, its bin deletes it once asked.
    await click('Conversation');
    await click(/^Why is this slow\?$/);
    await until(() => text().includes('Use an index.'));
    expect(text()).toContain('Use an index.');
    expect(root().querySelector('.list')).toBeNull();

    const asked: unknown[] = [];
    state.confirm = (message, params) => {
      asked.push([message, params]);
      return asked.length > 1;
    };
    await click('Conversation');
    await click('Delete the conversation «Why is this slow?»');
    expect(api.documentsStore).toHaveLength(1);
    await click('Delete the conversation «Why is this slow?»');
    expect(asked).toEqual([
      ['ai.conversation.confirm', { v0: 'Why is this slow?' }],
      ['ai.conversation.confirm', { v0: 'Why is this slow?' }],
    ]);
    expect(api.documentsStore).toEqual([]);
    expect(text()).toContain('Ask anything about your query');
    expect(text()).toContain('No conversations yet');
    // Escape, or a click elsewhere, closes the list.
    root()
      .querySelector('app-ai-conversations')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(root().querySelector('.list')).toBeNull();
    await click('Conversation');
    document.body.click();
    await settle();
    expect(root().querySelector('.list')).toBeNull();
  });

  it('shows what the model reasons while it thinks, folded once it answers', async () => {
    await create();
    let release!: () => void;
    const answered = new Promise<void>((done) => (release = done));
    polls.push({ text: '', next: 0, thinking: 'The person wants', thinkingNext: 16, done: false });
    api.responses['ai.poll'] = async () => {
      const next = polls.shift();
      if (next) return next;
      await answered;
      return { text: 'SELECT 1', next: 8, thinking: '', thinkingNext: 16, done: true };
    };
    await ask('Count');
    await until(() => text().includes('The person wants'));
    const live = root().querySelector('details.ai-thinking') as HTMLDetailsElement;
    expect(live.open).toBe(true);
    expect(live.querySelector('summary')?.textContent).toContain('Thinking…');
    release();
    await until(() => text().includes('SELECT 1') && !root().querySelector('[aria-busy]'));
    const kept = root().querySelector('details.ai-thinking') as HTMLDetailsElement;
    expect(kept.open).toBe(false);
    expect(kept.querySelector('summary')?.textContent).toMatch(/Thought for \d+ s/);
    expect(kept.textContent).toContain('The person wants');
    const [document] = api.documentsStore;
    expect((document.value as { messages: unknown[] }).messages[1]).toMatchObject({
      text: 'SELECT 1',
      thinking: 'The person wants',
    });
  });

  it('stops an answer and says why another one failed', async () => {
    await create();
    let stopped = false;
    api.responses['ai.stop'] = () => {
      stopped = true;
      return { stopped: true };
    };
    api.responses['ai.poll'] = () =>
      new Promise((done) =>
        setTimeout(
          () =>
            done(
              stopped
                ? { text: '', next: 3, done: true, stop: 'stopped' }
                : { text: stopped ? '' : 'One', next: 3, done: false },
            ),
          0,
        ),
      );
    await fill(fixture, 'Ask the assistant', 'Count');
    await clickButton(fixture, /^Send$/);
    await until(() => buttons(root(), /^Stop$/).length > 0);
    await clickButton(fixture, /^Stop$/);
    await until(() => text().includes('You stopped the answer here.'));
    expect(text()).toContain('You stopped the answer here.');

    api.responses['ai.chat'] = () => {
      throw new ApiFailure('The provider refused the API key', 'validation', 400);
    };
    await ask('Again');
    await until(() => !!root().querySelector('.ai-message-failed'));
    expect(root().querySelector('.ai-message-failed')?.textContent).toContain(
      'The provider refused the API key',
    );
  });

  it('asks about the place, shows the tools it read with and adds its tests', async () => {
    state.tabsStore.open({ ...newRequest('r1'), name: 'Login' });
    await create(true, 'request');
    api.responses['ai.tool'] = { text: 'the request' };
    polls.push(
      { text: '', next: 0, done: false, tools: [{ id: 't1', name: 'read_open', input: {} }] },
      { text: 'Add this:\n```javascript\npm.test("ok", () => {});\n```', next: 40, done: true },
    );
    await ask('Write tests for the request I have open');
    await until(() => api.documentsStore.length > 0);
    const chat = api.calls.find((call) => call.operation === 'ai.chat')!.payload;
    expect(chat['tools']).toBe('request');
    expect(chat['messages']).toEqual([
      { role: 'user', text: expect.stringContaining('Write tests for the request I have open') },
    ]);
    expect(api.calls.find((call) => call.operation === 'ai.tool')!.payload).toMatchObject({
      name: 'read_open',
      context: { place: 'request', request: { name: 'Login' } },
    });
    expect(api.calls.find((call) => call.operation === 'ai.continue')!.payload).toEqual({
      id: 'c1',
      results: [{ id: 't1', text: 'the request' }],
    });
    expect(text()).toContain('Read what is open');
    await click('Add to the tests');
    expect(state.active()!.request.tests).toBe('pm.test("ok", () => {});\n');
    expect(state.toast()).toMatchObject({ title: 'Added to the tests' });
  });

  it('gives the code of an answer to the place it is in', async () => {
    await create(true, 'mongo');
    const used: AiUse[] = [];
    fixture.componentRef.setInput('host', {
      context: () => ({ place: 'mongo', collection: 'orders' }),
      use: (use: AiUse) => used.push(use),
    });
    polls.push({ text: '```json\n{ "paid": true }\n```', next: 20, done: true });
    await ask('Only the paid ones');
    await until(() => api.documentsStore.length > 0);
    await click('Use in the query');
    expect(used).toEqual([{ action: 'use', code: '{ "paid": true }', language: 'json' }]);
    // No buttons of ready-made questions: the room goes to the answer.
    expect(text()).not.toContain('Document this collection');
  });
});
