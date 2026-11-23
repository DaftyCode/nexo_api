import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ApiFailure } from '../application/ports';
import { AI } from '../composition/providers';
import { clickButton, control, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { IntegrationPanel } from './integration-panel';
import { WorkspaceState } from './workspace-state';

describe('AiSettingsPanel', () => {
  let fixture: ComponentFixture<IntegrationPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({ 'ai.models': { models: [{ id: 'gpt-x', name: 'GPT X' }] } }),
      imports: [IntegrationPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(IntegrationPanel);
    await settle();
    await click(/^AI assistant$/);
  });

  it('is off until it is turned on, and keeps the key in the vault', async () => {
    expect(text()).toContain('What leaves your computer');
    expect(text()).toContain('The assistant is off');
    // The model inside Nexo first: nothing leaves the computer.
    expect(text()).toContain('Model inside Nexo');
    expect(text()).not.toContain('API key');
    await fill(fixture, 'Provider', 'anthropic');
    await settle();
    expect(text()).toContain('Effort');
    (control(root(), 'Use the AI assistant') as HTMLInputElement).click();
    await settle();
    expect(text()).toContain('Paste the API key of the provider');
    await fill(fixture, 'Provider', 'openai');
    await settle();
    expect(text()).not.toContain('Effort');
    await fill(fixture, 'API key', 'sk-test');
    await click('List the models');
    expect(api.secretNames).toEqual(['ai:openai']);
    expect(api.calls.at(-1)).toEqual({
      operation: 'ai.models',
      payload: { workspace: 'local', provider: 'openai' },
    });
    expect(state.toast()).toMatchObject({ title: 'Models listed', params: { v0: '1' } });
    expect(root().querySelector('datalist option')?.getAttribute('value')).toBe('gpt-x');
    expect(text()).toContain('Choose the model to ask');
    await fill(fixture, 'Model', 'gpt-x');
    await click(/^Save$/);
    expect(TestBed.inject(AI).settings()).toMatchObject({
      enabled: true,
      provider: 'openai',
      model: 'gpt-x',
    });
    expect(state.toast()).toMatchObject({ title: 'Assistant saved' });

    state.confirm = () => true;
    await click('Delete key');
    expect(api.secretNames).toEqual([]);
    expect(state.toast()).toMatchObject({ title: 'Key deleted' });
  });

  it('asks a compatible server for its address and says why the models are not listed', async () => {
    (control(root(), 'Use the AI assistant') as HTMLInputElement).click();
    await fill(fixture, 'Provider', 'compatible');
    await settle();
    expect(text()).toContain('Write the address of the server compatible with OpenAI.');
    await fill(fixture, 'Address of the server', 'http://127.0.0.1:8080/v1');
    api.responses['ai.models'] = () => {
      throw new ApiFailure('The provider failed', 'validation', 400);
    };
    await click('List the models');
    expect(api.calls.at(-1)?.payload).toMatchObject({ baseUrl: 'http://127.0.0.1:8080/v1' });
    expect(state.toast()).toMatchObject({ title: 'The models could not be listed' });
    // Cancelling the deletion keeps the key.
    api.secretNames.push('ai:compatible');
    await fill(fixture, 'Provider', 'anthropic');
    await fill(fixture, 'Provider', 'compatible');
    await settle();
    state.confirm = () => false;
    await click('Delete key');
    expect(api.secretNames).toEqual(['ai:compatible']);
  });
});
