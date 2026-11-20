// Importing the exports of other API clients: their report, and Bruno collection folders.
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton, fill } from '../testing/controls';
import { Workspace } from './workspace';
import { WorkspaceState } from './workspace-state';

describe('Workspace imports from other tools', () => {
  let fixture: ComponentFixture<Workspace>;
  let state: WorkspaceState;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const dialog = () => root().querySelector<HTMLElement>('[role="dialog"]');
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };
  /** Files of a chosen folder, with their paths inside it. */
  const folder = (entries: [string, string][]) =>
    entries.map(([path, content]) => {
      const file = new File([content], path.split('/').at(-1)!);
      Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
  const choose = async (files: File[]) => {
    const input = dialog()!.querySelector<HTMLInputElement>('input[webkitdirectory]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [Workspace],
    }).compileComponents();
    fixture = TestBed.createComponent(Workspace);
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    await state.initialize();
    await settle();
  });

  it('creates the environments that came with a collection and shows the report', async () => {
    api.responses['import'] = {
      kind: 'collection',
      name: 'Shop API',
      value: { info: { name: 'Shop API' }, item: [] },
      more: [
        { kind: 'environment', name: 'Development', value: { name: 'Development', values: [] } },
      ],
      report: {
        source: 'insomnia',
        requests: 4,
        folders: 1,
        environments: 1,
        notes: [{ code: 'script', item: 'List users' }],
      },
    };
    await clickButton(fixture, 'Import');
    await fill(fixture, 'Import content', '{"_type": "export"}', dialog()!);
    await clickButton(fixture, /^\s*Import\s*$/, dialog()!.querySelector('.modal-actions')!);
    await settle();
    expect(state.collections().map((c) => c.name)).toContain('Shop API');
    expect(state.environments().map((e) => e.name)).toContain('Development');
    expect(dialog()?.getAttribute('aria-label')).toBe('Import report');
    expect(dialog()!.textContent).toContain(
      'Imported from Insomnia. Requests: 4, folders: 1, environments: 1.',
    );
    expect(dialog()!.textContent).toContain('List users');
    expect(dialog()!.querySelector('.modal-actions .primary')).toBeNull();
    await clickButton(fixture, 'Close', dialog()!);
    expect(dialog()).toBeNull();
  });

  it('sends the files of a Bruno collection folder and leaves the rest out', async () => {
    api.responses['import'] = {
      kind: 'collection',
      name: 'Pet Store',
      value: { info: { name: 'Pet Store' }, item: [] },
      report: { source: 'bruno', requests: 1, folders: 0, environments: 0, notes: [] },
    };
    await clickButton(fixture, 'Import');
    await choose(
      folder([
        ['pets/bruno.json', '{"name": "Pet Store"}'],
        ['pets/Get.bru', 'get {\n  url: http://a.test\n}\n'],
        ['pets/node_modules/x/b.bru', 'never'],
        ['pets/readme.md', 'never'],
      ]),
    );
    const call = api.calls.find((c) => c.operation === 'import');
    expect(call?.payload).toEqual({
      content: '',
      files: [
        { path: 'pets/bruno.json', content: '{"name": "Pet Store"}' },
        { path: 'pets/Get.bru', content: 'get {\n  url: http://a.test\n}\n' },
      ],
    });
    expect(dialog()!.textContent).toContain('Everything came as it was.');
  });

  it('says that a folder without bruno.json is not a Bruno collection', async () => {
    await clickButton(fixture, 'Import');
    await choose(folder([['pets/Get.bru', 'get {\n}\n']]));
    expect(state.toast()).toMatchObject({
      kind: 'error',
      title: 'The import failed',
      detail: 'Choose the folder of a Bruno collection, the one with bruno.json',
    });
    expect(api.calls.some((c) => c.operation === 'import')).toBe(false);
    await choose([]);
    expect(dialog()?.getAttribute('aria-label')).toBe('Import your work');
  });

  it('closes when an import without a report ends, from a file too', async () => {
    api.responses['import'] = {
      kind: 'collection',
      name: 'Plain',
      value: { info: { name: 'Plain' }, item: [] },
    };
    await clickButton(fixture, 'Import');
    const file = dialog()!.querySelector<HTMLInputElement>(
      'input[type="file"]:not([webkitdirectory])',
    )!;
    Object.defineProperty(file, 'files', { value: [new File(['{}'], 'plain.json')] });
    file.dispatchEvent(new Event('change'));
    await settle();
    expect(dialog()).toBeNull();
    expect(state.imported()).toBeUndefined();
  });
});
