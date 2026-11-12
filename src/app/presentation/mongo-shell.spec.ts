import { ComponentFixture, TestBed } from '@angular/core/testing';
import { WorkspaceDocument } from '../domain/models';
import {
  clickButton,
  codeEditor,
  codeText,
  fill,
  renderDeferred,
  typeCode,
} from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://localhost:27017' },
};

describe('MongoShell', { timeout: 20_000 }, () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const shell = () => root().querySelector<HTMLElement>('app-mongo-shell')!;
  const settle = async () => {
    for (let i = 0; i < 6; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const calls = () => api.calls.filter((c) => c.operation === 'mongo.shell');
  const type = async (command: string) => {
    typeCode(codeEditor(shell(), 'Shell command'), command);
    await settle();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', sizeOnDisk: 2048, empty: false }] },
        'mongo.collections': {
          collections: [{ name: 'orders', kind: 'collection', capped: false }],
        },
        'mongo.shell': (payload: Record<string, unknown>) => {
          const command = String(payload['command']);
          if (command.includes('drop') && payload['confirm'] !== 'orders')
            throw new Error('Type the name of the collection to confirm: orders');
          if (command.startsWith('use'))
            return {
              database: 'logs',
              kind: 'value',
              value: 'switched to db logs',
              logs: [],
              elapsedMs: 1,
            };
          if (command.includes('drop'))
            return { database: 'shop', kind: 'value', value: true, logs: [], elapsedMs: 3 };
          return {
            database: String(payload['database']),
            kind: 'documents',
            value: [{ _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' }, n: { $numberInt: '1' } }],
            logs: [['found', '1']],
            elapsedMs: 4,
          };
        },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.applySaved([connection]);
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection);
    await settle();
    await click('shop');
    await click(/^Shell$/);
  });

  it('runs commands, shows what they gave and follows use', async () => {
    expect(shell().querySelector('[data-testid="shell-database"]')?.textContent).toContain('shop>');
    await type('db.orders.find({ n: 1 })');
    await click(/^Run$/, shell());
    expect(calls()[0].payload).toMatchObject({
      connection: 'c1',
      database: 'shop',
      command: 'db.orders.find({ n: 1 })',
      variables: {},
    });
    const output = shell().querySelector('[role="log"]')!.textContent ?? '';
    expect(output).toContain('shop> db.orders.find({ n: 1 })');
    expect(output).toContain('found 1');
    expect(output).toContain('1 documents · 4 ms');
    expect(output).toContain('ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")');

    await type('use logs');
    await click(/^Run$/, shell());
    expect(shell().querySelector('[data-testid="shell-database"]')?.textContent).toContain('logs>');
    expect(shell().textContent).toContain('switched to db logs');
    // The collections of the database are suggested in the editor.
    expect(fixture.componentInstance.shell.words()).toContain('db.orders.find');
  });

  it('asks for the name before a destructive command', async () => {
    await type('db.orders.drop()');
    await click(/^Run$/, shell());
    expect(shell().textContent).toContain('This command drops or empties the collection orders');
    expect(calls()).toHaveLength(1);
    const run = [...shell().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Run it'),
    )!;
    expect(run.disabled).toBe(true);
    await fill(fixture, 'Type orders to confirm', 'orders', shell());
    await click('Run it', shell());
    expect(calls()[1].payload).toMatchObject({ command: 'db.orders.drop()', confirm: 'orders' });
    expect(shell().querySelector('[role="log"]')!.textContent).toContain('true');
    expect(shell().textContent).not.toContain('This command drops');
  });

  it('keeps the history of the connection and goes through it', async () => {
    for (const command of ['db.orders.find()', 'db.orders.countDocuments()']) {
      await type(command);
      await click(/^Run$/, shell());
    }
    await click('Previous command', shell());
    expect(codeText(shell(), 'Shell command')).toBe('db.orders.countDocuments()');
    await click('Previous command', shell());
    expect(codeText(shell(), 'Shell command')).toBe('db.orders.find()');
    await click('Next command', shell());
    expect(codeText(shell(), 'Shell command')).toBe('db.orders.countDocuments()');
    await click(/^Close the shell$/, shell());
    expect(root().querySelector('app-mongo-shell')).toBeNull();
    // Opened again, the history is still there.
    await click(/^Shell$/);
    expect(shell().textContent).toContain('db.orders.countDocuments()');
    await click(/^Clear$/, shell());
    expect(shell().querySelector('[role="log"]')!.textContent).toContain(
      'Write a command as in mongosh',
    );
  });
});
