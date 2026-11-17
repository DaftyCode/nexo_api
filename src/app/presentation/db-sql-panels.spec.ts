import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, change, clickButton, codeText, typeCode } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { DbSection } from './db-panel/section';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'postgres',
  name: 'PostgreSQL',
  description: '',
  version: '0.7.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'postgres', host: 'db', database: 'shop' },
};

/** Splits by semicolons, every statement a read. */
function split(payload: Record<string, unknown>) {
  const script = String(payload['script']);
  const statements: unknown[] = [];
  let start = 0;
  for (const part of script.split(';')) {
    const text = part.trim();
    if (text) {
      const from = start + part.indexOf(text);
      statements.push({
        text,
        start: from,
        end: from + text.length,
        line: script.slice(0, from).split('\n').length,
        classification: {
          kind: /^select/i.test(text) ? 'read' : 'write',
          missingWhere: false,
          truncate: false,
          drop: [],
          drops: false,
        },
      });
    }
    start += part.length + 1;
  }
  return { statements, current: statements.length ? 0 : null };
}

describe('the console, outline and templates of the SQL editor', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 12; i++) await fixture.whenStable();
  };
  const script = () => root().querySelector('.cm-content[aria-label="SQL script"]')!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
        'db.transaction': () => ({ autoCommit: true, open: false }),
        'db.split': split,
        'db.execute': (payload: Record<string, unknown>) =>
          /^select/i.test(String(payload['sql']))
            ? {
                columns: [{ name: 'total', typeName: 'int4', kind: 'integer' }],
                rows: [[42]],
                elapsedMs: 1,
              }
            : { columns: [], rows: [], affected: 3, elapsedMs: 1 },
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection);
    await state.refresh();
    state.databaseSession.set({
      expanded: [],
      active: 'c1',
      bookmarks: [],
      simple: true,
      tabs: [],
      activeTab: '',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });

  it('runs what is typed in the console and shows its rows and messages as text', async () => {
    const section = fixture.debugElement.injector.get(DbSection);
    section.tabs.open({ kind: 'console', connection: 'c1', title: 'Console' });
    await settle();
    const prompt = root().querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Statement to run"]',
    )!;
    const enter = (text: string) => {
      change(prompt, text);
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    enter('select total from orders');
    await settle();
    enter('update orders set paid = true');
    await settle();
    const log = root().querySelector('[role="log"]')!.textContent ?? '';
    expect(log).toContain('> select total from orders');
    expect(log).toMatch(/total\s*\n-+\s*\n42/);
    expect(log).toContain('> update orders set paid = true');
    expect(log).toContain('3');
    // The arrows bring back what was typed, newest first.
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    expect(prompt.value).toBe('update orders set paid = true');
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    expect(prompt.value).toBe('select total from orders');
    // What was read is kept as text only: no result tab or cursor stays open.
    expect(section.runner(section.tabs.active()!.id).results.tabs()).toEqual([]);
  });

  it('lists the statements of the script in the outline and goes to one', async () => {
    await clickButton(fixture, 'New SQL script');
    await settle();
    typeCode(script(), 'select 1;\n\nupdate orders set paid = true');
    await settle();
    await clickButton(fixture, 'Outline');
    await new Promise((done) => setTimeout(done, 500));
    await settle();
    const entries = [...root().querySelectorAll('.db-outline-entry')];
    expect(entries.map((entry) => entry.querySelector('.db-outline-line')?.textContent)).toEqual([
      '1',
      '3',
    ]);
    expect(entries.map((entry) => entry.querySelector('code')?.textContent)).toEqual([
      'select 1',
      'update orders set paid = true',
    ]);
  });

  it('adds and removes the person’s own templates, kept on this computer', async () => {
    await clickButton(fixture, 'New SQL script');
    await settle();
    await clickButton(fixture, 'Templates');
    await settle();
    const form = root().querySelector<HTMLFormElement>('.db-template-form')!;
    const [name, description] = [...form.querySelectorAll('input')];
    change(name, 'top');
    change(description, 'First rows');
    change(form.querySelector('textarea')!, 'SELECT * FROM ${table} LIMIT 10');
    await settle();
    await clickButton(fixture, 'Add');
    await settle();
    expect(root().querySelector('.db-templates')!.textContent).toContain('First rows');
    const section = fixture.debugElement.injector.get(DbSection);
    const cases = await section.cases();
    expect(cases.assist.templates().map((template) => template.name)).toEqual(['top']);
    buttons(root(), 'Remove the template top')[0].click();
    await settle();
    expect(root().querySelector('.db-templates')!.textContent).not.toContain('First rows');
    expect(cases.assist.templates()).toEqual([]);
  });

  it('changes the case of the word at the cursor with DBeaver’s keys', async () => {
    await clickButton(fixture, 'New SQL script');
    await settle();
    typeCode(script(), 'select');
    await settle();
    script().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'X',
        keyCode: 88,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await settle();
    expect(codeText(root(), 'SQL script')).toBe('SELECT');
  });
});
