import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton, fill, valueOf } from '../testing/controls';
import { RunnerPanel } from './runner-panel';
import { WorkspaceState } from './workspace-state';

describe('RunnerPanel', () => {
  let component: RunnerPanel;
  let fixture: ComponentFixture<RunnerPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  // Inputs, selects and code editors alike.
  const field = (label: string) => ({ value: valueOf(root(), label) });
  const type = (label: string, value: string) => fill(fixture, label, value);
  const waitPoll = () => new Promise((resolve) => setTimeout(resolve, 450));
  const result = (name: string, status: number) => ({
    name,
    status,
    statusText: 'OK',
    headers: [],
    body: '',
    time: 3,
    size: 0,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [RunnerPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(RunnerPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('validates the run before starting it', async () => {
    expect(root().querySelector<HTMLButtonElement>('.button.primary.wide')!.disabled).toBe(true);
    await state.createCollection('Shop');
    await settle();
    await type('Iteration data (JSON array)', '{ broken');
    await clickButton(fixture, 'Run collection');
    await settle();
    expect(root().textContent).toContain('Iteration data must be a JSON array');
    await clickButton(fixture, 'Dismiss error');
    await type('Iteration data (JSON array)', '{"a":1}');
    await clickButton(fixture, 'Run collection');
    await settle();
    expect(root().textContent).toContain('Iteration data must be a JSON array');
  });

  it('runs a collection, follows its progress and records the result', async () => {
    await state.createCollection('Shop');
    await settle();
    let polls = 0;
    api.responses['run'] = ({ action }: Record<string, unknown>) =>
      action === 'status'
        ? ++polls === 1
          ? {
              id: 'run-1',
              state: 'running',
              results: [result('List', 200)],
              assertions: [{ name: 'ok', passed: true, skipped: false }],
              logs: [],
              counts: { results: 1, assertions: 1, logs: 0 },
            }
          : {
              id: 'run-1',
              state: 'finished',
              results: [
                { ...result('Create', 0), error: 'Secret key cannot be sent to evil.test' },
              ],
              assertions: [
                { name: 'created', passed: false, skipped: false, error: 'Expected 201' },
              ],
              logs: [],
              duration: 20,
              error: 'Secret key cannot be sent to evil.test',
              counts: { results: 2, assertions: 2, logs: 0 },
            }
        : { id: 'run-1', state: 'running' };
    const file = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    api.responses['dataset.parse'] = { rows: [{ user: 'ada' }] };
    Object.defineProperty(file, 'files', { value: [new File(['user\nada'], 'users.csv')] });
    file.dispatchEvent(new Event('change'));
    await settle();
    expect(field('Iteration data (JSON array)').value).toContain('"user": "ada"');
    await type('Iterations', '2');

    await clickButton(fixture, 'Run collection');
    await settle();
    expect(api.calls.find((call) => call.operation === 'run')?.payload).toMatchObject({
      iterations: 2,
      data: [{ user: 'ada' }],
    });
    expect(root().textContent).toContain('Stop run');
    await waitPoll();
    await settle();
    expect(root().textContent).toContain('Running collection');
    expect(root().querySelector('.assertion')?.textContent).toContain('ok');
    await waitPoll();
    await settle();
    expect(root().textContent).toContain('Expected 201');
    expect(root().textContent).toContain('evil.test');
    expect(state.documents().some((d) => d.kind === 'run')).toBe(true);

    await clickButton(fixture, 'Export PDF');
    const report = state.report();
    expect(report?.kind).toBe('run');
    expect(report?.title).toBe('Shop');
  });

  it('stops a running collection and reports polling errors', async () => {
    await state.createCollection('Shop');
    await settle();
    api.responses['run'] = ({ action }: Record<string, unknown>) => {
      if (action === 'status') throw new Error('Run not found');
      return { id: 'run-2', state: 'running' };
    };
    api.responses['cancel'] = {
      id: 'run-2',
      state: 'cancelled',
      results: [],
      assertions: [],
      logs: [],
    };
    await clickButton(fixture, 'Run collection');
    await settle();
    await clickButton(fixture, 'Stop run');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({ operation: 'cancel', payload: { id: 'run-2' } });
    expect(root().textContent).toContain('cancelled');
  });

  it('pauses and resumes a run, with a delay between requests', async () => {
    await state.createCollection('Shop');
    await settle();
    let state_ = 'running';
    api.responses['run'] = ({ action }: Record<string, unknown>) =>
      action === 'status'
        ? { id: 'run-3', state: state_, results: [], assertions: [], logs: [], counts: {} }
        : { id: 'run-3', state: 'running' };
    api.responses['run.pause'] = () => ((state_ = 'paused'), { id: 'run-3', state: 'paused' });
    api.responses['run.resume'] = () => ((state_ = 'running'), { id: 'run-3', state: 'running' });
    api.responses['cancel'] = {
      id: 'run-3',
      state: 'cancelled',
      results: [],
      assertions: [],
      logs: [],
    };
    await type('Delay between requests (ms)', '250');
    await clickButton(fixture, 'Run collection');
    await settle();
    expect(api.calls.find((call) => call.operation === 'run')?.payload['delay']).toBe(250);

    await clickButton(fixture, 'Pause');
    await settle();
    expect(api.calls.at(-1)).toMatchObject({ operation: 'run.pause', payload: { id: 'run-3' } });
    expect(root().textContent).toContain('Run paused');
    expect(root().textContent).toContain('the next one waits for Resume');
    // While paused, the status is asked for less often: after the poll already scheduled,
    // the next one waits two seconds.
    const polls = () => api.calls.filter((call) => call.payload['action'] === 'status').length;
    await waitPoll();
    await settle();
    const before = polls();
    await waitPoll();
    await settle();
    expect(polls()).toBe(before);

    await clickButton(fixture, 'Resume');
    await settle();
    expect(api.calls.at(-1)?.operation).toBe('run.resume');
    expect(root().textContent).toContain('Running collection');
    await clickButton(fixture, 'Stop run');
    await settle();
    expect(api.calls.at(-1)?.operation).toBe('cancel');
  });
});
