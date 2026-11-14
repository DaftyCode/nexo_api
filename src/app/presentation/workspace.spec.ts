import { testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

describe('Workspace', () => {
  let component: Workspace;
  let fixture: ComponentFixture<Workspace>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();

    fixture = TestBed.createComponent(Workspace);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('changes English and Spanish in every template without changing request data or environment', async () => {
    const state = TestBed.inject(WorkspaceState);
    await state.initialize();
    state.documents.set([
      {
        id: 'env-language-test',
        workspace_id: 'local',
        kind: 'environment',
        name: 'My environment',
        revision: 1,
        updated_at: 1,
        value: { values: [{ key: 'baseUrl', value: 'https://example.test' }] },
      },
    ]);
    state.environmentId.set('env-language-test');
    state.edit({
      ...state.active()!.request,
      url: 'https://example.test/do-not-translate',
      body: '{"message":"Send"}',
    });
    state.tabsStore.setResponse(state.activeTabId(), {
      status: 200,
      statusText: 'OK',
      time: 1,
      size: 1,
      body: '{"message":"English"}',
      headers: [],
      assertions: [],
      logs: [],
    });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const language = root.querySelector<HTMLSelectElement>(
      'select[aria-label="Language / Idioma"]',
    )!;
    const template = root.querySelector<HTMLSelectElement>('app-appearance-selector select')!;
    for (const layout of ['aurora', 'studio', 'canvas']) {
      template.value = layout;
      template.dispatchEvent(new Event('input', { bubbles: true }));
      template.dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
      for (const [code, send] of [
        ['es', 'Enviar'],
        ['en', 'Send'],
      ]) {
        language.value = code;
        language.dispatchEvent(new Event('input', { bubbles: true }));
        language.dispatchEvent(new Event('change', { bubbles: true }));
        await fixture.whenStable();
        expect(root.querySelector('.url-toolbar .send')?.textContent?.trim()).toBe(send);
        expect(state.active()?.request.url).toBe('https://example.test/do-not-translate');
        expect(state.active()?.request.body).toBe('{"message":"Send"}');
        expect(state.response()?.body).toBe('{"message":"English"}');
        expect(state.environmentId()).toBe('env-language-test');
      }
    }
  });

  it('switches templates immediately without replacing the active request', async () => {
    await TestBed.inject(WorkspaceState).initialize();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const studio = root.querySelector('.studio')!;
    const url = root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')!;
    const selector = root.querySelector<HTMLSelectElement>('select[aria-label="Visual template"]')!;
    expect(studio.getAttribute('data-template')).toBe('aurora');
    url.value = 'https://example.test/keep-this-request';
    url.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(Array.from(selector.options, (option) => option.value)).toEqual([
      'aurora',
      'studio',
      'canvas',
    ]);
    for (const template of ['studio', 'canvas']) {
      selector.value = template;
      selector.dispatchEvent(new Event('input', { bubbles: true }));
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
      expect(studio.getAttribute('data-template')).toBe(template);
      expect(root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')?.value).toBe(
        'https://example.test/keep-this-request',
      );
      expect(
        Array.from(root.querySelectorAll('.rail button'), (button) => button.textContent?.trim()),
      ).toEqual([
        'Collections',
        'Environments',
        'History',
        'Runner',
        'Protocols',
        'Mocks',
        'Datasets',
        'Databases',
        'MongoDB',
        'Git',
        'MCP',
        'Settings',
      ]);
    }
    root.querySelector<HTMLButtonElement>('[aria-label="Open workspace tools"]')!.click();
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(true);
    root.querySelector<HTMLButtonElement>('[aria-label="Close workspace navigation"]')!.click();
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(false);
    TestBed.inject(WorkspaceState).section.set('history');
    await fixture.whenStable();
    expect(studio.classList.contains('canvas-navigation-visible')).toBe(true);
    selector.value = 'aurora';
    selector.dispatchEvent(new Event('input', { bubbles: true }));
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await fixture.whenStable();
    expect(studio.getAttribute('data-template')).toBe('aurora');
    expect(root.querySelector<HTMLInputElement>('input[aria-label="Request URL"]')?.value).toBe(
      'https://example.test/keep-this-request',
    );
  });
});
