import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testProviders } from '../testing/providers';
import { AppearanceState } from './appearance-state';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

describe('the workspace and the events of its parts', () => {
  let fixture: ComponentFixture<Workspace>;
  let state: WorkspaceState;
  let appearance: AppearanceState;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
  };
  const emit = async (selector: string, output: string, value?: unknown) => {
    fixture.debugElement.query(By.css(selector)).triggerEventHandler(output, value);
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'http.send': () => ({
          status: 200,
          statusText: 'OK',
          headers: [],
          body: '',
          time: 1,
          size: 0,
        }),
      }),
      imports: [Workspace],
    }).compileComponents();
    state = TestBed.inject(WorkspaceState);
    appearance = TestBed.inject(AppearanceState);
    fixture = TestBed.createComponent(Workspace);
    await state.initialize();
    await settle();
  });

  it('hands the events of the request editor to the workspace', async () => {
    const send = vi.spyOn(state, 'send').mockResolvedValue(undefined as never);
    const cancel = vi.spyOn(state, 'cancel').mockResolvedValue(undefined as never);
    const save = vi.spyOn(state, 'saveActive').mockResolvedValue(undefined as never);
    const cookies = vi.spyOn(state, 'manageCookies').mockImplementation(() => undefined as never);
    const inherited = vi.spyOn(state, 'editInheritedAuth').mockImplementation(() => undefined);
    const token = vi.spyOn(state, 'oauth2Token').mockResolvedValue(undefined as never);
    await emit('app-request-editor', 'requestChange', {
      ...state.active()!.request,
      url: 'https://x.test',
    });
    expect(state.active()?.request.url).toBe('https://x.test');
    await emit('app-request-editor', 'send');
    await emit('app-request-editor', 'cancelRequest');
    await emit('app-request-editor', 'save');
    await emit('app-request-editor', 'cookies');
    await emit('app-request-editor', 'editInheritedAuth');
    await emit('app-request-editor', 'oauth2Token', true);
    expect(
      [send, cancel, save, cookies, inherited, token].map((spy) => spy.mock.calls.length),
    ).toEqual([1, 1, 1, 1, 1, 1]);
    await emit('app-request-editor', 'code');
    expect(state.section()).toBe('code');
    state.section.set('collections');
    await settle();
    await emit('app-request-editor', 'manageVariables');
    expect(state.section()).toBe('environments');
  });

  it('resizes and restores its panels, and exports the response', async () => {
    const report = vi.spyOn(state, 'reportRequest').mockImplementation(() => undefined as never);
    const resize = vi.spyOn(appearance, 'resize');
    const reset = vi.spyOn(appearance, 'reset');
    const saved = vi.spyOn(appearance, 'save');
    await emit('app-splitter.request-splitter', 'resized', 300);
    await emit('app-splitter.request-splitter', 'settled');
    await emit('app-splitter.request-splitter', 'restore');
    await emit('app-response-view', 'exportPdf');
    expect(report).toHaveBeenCalled();
    const studio = fixture.debugElement.query(By.css('app-splitter.context-splitter'));
    if (studio) {
      studio.triggerEventHandler('resized', 400);
      studio.triggerEventHandler('settled');
      studio.triggerEventHandler('restore');
    }
    expect(resize).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
    expect(saved).toHaveBeenCalled();
  });

  it('opens the shortcuts, and in the canvas template browses collections and splits sideways', async () => {
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[aria-label="Keyboard shortcuts"]')!.click();
    await settle();
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    appearance.model.set({ template: 'canvas' });
    state.section.set('history');
    await settle();
    const browse = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Browse collections'),
    );
    browse?.click();
    await settle();
    expect(state.section()).toBe('collections');
    const resize = vi.spyOn(appearance, 'resize');
    await emit('app-splitter.request-splitter', 'resized', 500);
    await emit('app-splitter.request-splitter', 'settled');
    await emit('app-splitter.request-splitter', 'restore');
    expect(resize).toHaveBeenCalledWith('split', 500);
    const add = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('＋ New'),
    );
    const before = state.tabs().length;
    add?.click();
    await settle();
    expect(state.tabs().length).toBe(before + 1);
  });
});
