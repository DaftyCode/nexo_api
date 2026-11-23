import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiFailure } from '../application/ports';
import { AI } from '../composition/providers';
import { DEFAULT_AI_SETTINGS } from '../domain/ai';
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
  const create = async (ready = true) => {
    if (ready) {
      TestBed.inject(AI).saveSettings({ ...DEFAULT_AI_SETTINGS, enabled: true });
      api.secretNames.push('ai:anthropic');
    }
    fixture = TestBed.createComponent(AiChat);
    fixture.componentRef.setInput('place', 'sql');
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
    (control(root(), 'Use the AI assistant') as HTMLInputElement).click();
    await fill(fixture, 'API key', 'sk-test');
    await click(/^Save$/);
    await until(() => text().includes('Ask the assistant'));
    expect(text()).toContain('Ask the assistant');
    expect(api.secretNames).toEqual(['ai:anthropic']);
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
    await fill(fixture, 'Conversation', kept.id);
    await until(() => text().includes('Use an index.'));
    expect(text()).toContain('Use an index.');

    state.confirm = () => true;
    await click(/^Delete$/);
    expect(api.documentsStore).toEqual([]);
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
});
