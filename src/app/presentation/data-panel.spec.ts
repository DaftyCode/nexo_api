import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton, fill } from '../testing/controls';
import { DataPanel } from './data-panel';
import { WorkspaceState } from './workspace-state';

describe('DataPanel', () => {
  let component: DataPanel;
  let fixture: ComponentFixture<DataPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  // Inputs and code editors alike, by their accessible name or label.
  const type = (label: string, value: string) => fill(fixture, label, value);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [DataPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    fixture = TestBed.createComponent(DataPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('imports a dataset, queries it and deletes it', async () => {
    api.responses['dataset.import'] = { id: 'ds1', rows: 2, columns: ['name', 'requests'] };
    api.responses['dataset.query'] = {
      columns: ['name', 'meta'],
      rows: [
        { name: 'Ada', meta: { team: 'core' } },
        { name: null, meta: 3 },
      ],
      truncated: true,
    };
    await clickButton(fixture, 'Run query');
    await settle();
    expect(root().textContent).toContain('Import or choose a dataset first');
    await clickButton(fixture, 'Dismiss error');

    const file = root().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(file, 'files', {
      value: [new File(['name,requests\nAda,42'], 'people.csv')],
    });
    file.dispatchEvent(new Event('change'));
    await settle();
    expect(root().querySelector<HTMLInputElement>('[aria-label="Dataset name"]')!.value).toBe(
      'people',
    );
    await clickButton(fixture, 'Import dataset');
    await settle();
    expect(root().textContent).toContain('Imported 2 rows');
    expect(api.documentsStore.map((d) => [d.kind, d.name])).toEqual([['dataset', 'people']]);

    const dataset = root().querySelector<HTMLSelectElement>('[aria-label="Dataset"]')!;
    dataset.value = '';
    dataset.dispatchEvent(new Event('change'));
    dataset.value = 'ds1';
    dataset.dispatchEvent(new Event('change'));
    await type('SQL query', 'SELECT name FROM data');
    await clickButton(fixture, 'Run query');
    await settle();
    expect(api.calls.at(-1)?.payload).toMatchObject({ id: 'ds1', sql: 'SELECT name FROM data' });
    expect(root().textContent).toContain('2 rows (limit reached)');
    expect(root().querySelector('table')?.textContent).toContain('{"team":"core"}');

    await clickButton(fixture, 'Delete dataset');
    await settle();
    expect(root().textContent).toContain('Dataset deleted');
    expect(api.documentsStore).toEqual([]);
  });

  it('starts, lists, stops and restarts mocks', async () => {
    const running: { id: string; port: number; url: string }[] = [];
    api.responses['mock.start'] = ({ port }: Record<string, unknown>) => {
      const mock = {
        id: `m${running.length + 1}`,
        port: Number(port) || 4010,
        url: 'http://127.0.0.1:4010',
      };
      running.push(mock);
      return mock;
    };
    api.responses['mock.list'] = () => [...running];
    api.responses['mock.stop'] = ({ id }: Record<string, unknown>) => {
      running.splice(
        running.findIndex((mock) => mock.id === id),
        1,
      );
      return {};
    };
    fixture.componentRef.setInput('section', 'mocks');
    await fixture.whenStable();
    expect(root().textContent).toContain('Mock servers');
    expect(root().textContent).toContain("Your API, before it's built");

    await type('Mock examples JSON', '{"not":"a list"}');
    await clickButton(fixture, 'Start mock');
    await settle();
    expect(root().textContent).toContain('Mock examples must be a JSON array');

    await type('Mock examples JSON', '[{"path":"/hello","body":{"ok":true}}]');
    await clickButton(fixture, 'Start mock');
    await settle();
    expect(root().textContent).toContain('Mock is listening');
    expect(root().textContent).toContain('http://127.0.0.1:4010');
    expect(root().textContent).toContain('Saved mocks');

    await clickButton(fixture, 'Stop');
    await settle();
    expect(running).toEqual([]);
    expect(root().textContent).not.toContain('Mock is listening');

    await clickButton(fixture, /^\s*Start\s*$/);
    await settle();
    expect(running).toHaveLength(1);
    await clickButton(fixture, 'Refresh');

    state.confirm = () => true;
    await clickButton(fixture, /^\s*Delete\s*$/);
    await settle();
    expect(api.documentsStore.filter((d) => d.kind === 'mock')).toEqual([]);
  });
});
