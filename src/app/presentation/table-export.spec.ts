import { ComponentFixture, TestBed } from '@angular/core/testing';
import { clickButton, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { ExportedFile, TableExportOptions } from '../application/workspace-use-cases/table-export';
import { TableExport } from './table-export';
import { WorkspaceState } from './workspace-state';

describe('TableExport', () => {
  let fixture: ComponentFixture<TableExport>;
  let api: TestApi;
  let state: WorkspaceState;
  let asked: TableExportOptions[];
  let answer: () => Promise<ExportedFile>;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders(),
      imports: [TableExport],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push({
      id: 'pii',
      workspace_id: 'local',
      kind: 'masking',
      name: 'PII',
      revision: 1,
      updated_at: 0,
      value: { rules: [] },
    });
    await state.refresh();
    asked = [];
    answer = async () => ({
      name: 'orders.csv',
      type: 'text/csv',
      data: 'a\r\n',
      rows: 1,
      cut: false,
    });
    fixture = TestBed.createComponent(TableExport);
    fixture.componentRef.setInput('make', async (options: TableExportOptions) => {
      asked.push(options);
      return answer();
    });
    await settle();
  });

  it('asks the format, the separator and the masking set, then downloads the file', async () => {
    await clickButton(fixture, 'Export table…');
    await settle();
    expect(root().textContent).not.toContain('Separator');
    await fill(fixture, 'Format', 'csv');
    await fill(fixture, 'Separator', ';');
    await fill(fixture, 'Masking', 'pii');
    expect(root().textContent).toContain('PII');
    await clickButton(fixture, /^Export$/);
    await settle();
    expect(asked).toEqual([{ format: 'csv', separator: ';', set: 'pii' }]);
    expect(api.downloads).toEqual([{ name: 'orders.csv', content: '[object Blob]' }]);
    expect(state.toast()).toMatchObject({ title: 'File downloaded', message: 'toast.downloaded' });
    // The form closes once the file is saved.
    expect(root().textContent).toContain('Export table…');
  });

  it('says when something did not fit, and when the file could not be made', async () => {
    answer = async () => ({
      name: 'big.xlsx',
      type: 'x',
      data: new Uint8Array(),
      rows: 1,
      cut: true,
    });
    await clickButton(fixture, 'Export table…');
    await settle();
    await clickButton(fixture, /^Export$/);
    await settle();
    expect(asked[0]).toEqual({ format: 'xlsx', separator: ',', set: '' });
    expect(state.toast()).toMatchObject({
      message: 'toast.exportedCut',
      params: { v0: 'big.xlsx' },
    });

    answer = async () => {
      throw new Error('Run a collection first');
    };
    await clickButton(fixture, 'Export table…');
    await settle();
    await clickButton(fixture, /^Export$/);
    await settle();
    expect(state.toast()).toMatchObject({ kind: 'error', title: 'The file could not be exported' });
    await clickButton(fixture, /^Cancel$/);
    await settle();
    expect(root().textContent).toContain('Export table…');
  });
});
