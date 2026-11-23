import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AI } from '../../composition/providers';
import { DEFAULT_AI_SETTINGS } from '../../domain/ai';
import { clickButton, fill } from '../../testing/controls';
import { TEST_API, TestApi, testProviders } from '../../testing/providers';
import { AiChat } from '../ai-chat';
import { WorkspaceState } from '../workspace-state';
import { AiChatSession } from './session';

/** The panel of the chat: its width, the connection it reads and its provider. */
describe('AiChat panel', () => {
  let fixture: ComponentFixture<AiChat>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
  };
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
  const create = async (ready = true) => {
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
    fixture.componentRef.setInput('place', 'sql');
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [AiChat],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    TestBed.inject(WorkspaceState).workspaceId.set('local');
  });

  it('is made wider or narrower by dragging its edge, the same width in every place', async () => {
    await create(false);
    const panel = root().querySelector<HTMLElement>('aside.ai-chat')!;
    const edge = root().querySelector<HTMLElement>('app-splitter')!;
    expect(edge.getAttribute('aria-label')).toBe('Resize the AI assistant');
    expect(panel.style.width).toBe('');
    panel.getBoundingClientRect = () => ({ width: 400, height: 600 }) as DOMRect;
    const drag = (clientX: number) =>
      edge.dispatchEvent(
        Object.assign(new MouseEvent('pointermove', { bubbles: true, clientX }), { pointerId: 1 }),
      );
    edge.dispatchEvent(
      Object.assign(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }), {
        pointerId: 1,
      }),
    );
    // The panel lies after its edge: dragging left makes it wider.
    drag(400);
    await fixture.whenStable();
    expect(panel.style.width).toBe('500px');
    expect(TestBed.inject(AiChatSession).width()).toBe(500);
    // Never narrower than its least, nor wider than leaves room beside it (1024 − 320).
    drag(900);
    await fixture.whenStable();
    expect(panel.style.width).toBe('280px');
    drag(-1000);
    await fixture.whenStable();
    expect(panel.style.width).toBe('704px');
    edge.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    edge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await fixture.whenStable();
    expect(panel.style.width).toBe('');
  });

  it('says the connection it reads, and changes its provider without leaving the chat', async () => {
    await create();
    fixture.componentRef.setInput('host', {
      context: () => ({ place: 'sql', connection: 'Padel', connectionId: 'd1' }),
      use: () => undefined,
    });
    await settle();
    expect(text()).toContain('It reads Padel, the connection you work with here');
    expect(text()).toContain('Anthropic (Claude) · claude-opus-5-5');
    await click('Change');
    expect(root().querySelector('textarea')).toBeNull();
    expect(text()).toContain('Use the AI assistant');
    await click('Back to the conversation');
    expect(text()).toContain('Ask the assistant');
    // Another provider without its key: its settings ask for it, then the chat comes back.
    await click('Change');
    await fill(fixture, 'Provider', 'openai');
    await settle();
    await fill(fixture, 'API key', 'sk-openai');
    await fill(fixture, 'Model', 'gpt-5');
    await click(/^Save$/);
    await until(() => text().includes('OpenAI (ChatGPT) · gpt-5'));
    expect(api.secretNames).toContain('ai:openai');
    expect(root().querySelector('textarea')).not.toBeNull();
  });

  it('follows what is written, until the person scrolls up; at the end it follows again', async () => {
    await create();
    const log = root().querySelector<HTMLElement>('.ai-chat-log')!;
    let height = 1000;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 200 });
    // A message more on screen, as an answer that grows.
    const chat = fixture.componentInstance as unknown as {
      current: { update(change: (now: { messages: unknown[] }) => unknown): void };
    };
    const grow = async () => {
      height += 100;
      chat.current.update((now) => ({
        ...now,
        messages: [...now.messages, { role: 'user', text: 'more' }],
      }));
      await settle();
    };
    await grow();
    expect(log.scrollTop).toBe(height);
    // Scrolled up: it stays where the person left it.
    log.scrollTop = 300;
    log.dispatchEvent(new Event('scroll'));
    await grow();
    expect(log.scrollTop).toBe(300);
    // Back at the end: it follows again.
    log.scrollTop = height - 200;
    log.dispatchEvent(new Event('scroll'));
    await grow();
    expect(log.scrollTop).toBe(height);
  });
});
