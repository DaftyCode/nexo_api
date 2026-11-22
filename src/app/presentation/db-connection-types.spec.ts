import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../domain/models';
import { typeCode } from '../testing/controls';
import { DbPanelTest, startDbPanel } from '../testing/db-panel';

const staging = (value: Record<string, unknown>): WorkspaceDocument => ({
  id: 'staging',
  workspace_id: 'local',
  kind: 'connection-type',
  name: 'Staging',
  revision: 1,
  updated_at: 0,
  value,
});

/** Splits a script into one statement of the kind its verb says. */
function split(payload: Record<string, unknown>) {
  const text = String(payload['script']).trim();
  const verb = text.split(/\s/)[0].toLowerCase();
  const kind = verb === 'select' ? 'read' : verb === 'create' ? 'structure' : 'write';
  return {
    statements: [
      {
        text,
        start: 0,
        end: text.length,
        line: 1,
        classification: { kind, missingWhere: false, truncate: false, drop: [], drops: false },
      },
    ],
    current: 0,
  };
}

async function run(panel: DbPanelTest, sql: string) {
  typeCode(panel.root().querySelector('.cm-content[aria-label="SQL script"]')!, sql);
  await panel.settle();
  await panel.click(/^▶ Run$/);
}

describe('a connection of a type of your own', () => {
  it('shows its type in the navigator and in the form, which follows its commits', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'postgres', host: 'db', database: 'shop', type: 'staging' },
      documents: [staging({ autoCommit: false, confirmStructure: true })],
    });
    expect(panel.text()).toContain('Staging');
    panel.section().edit(panel.section().connection('c1'));
    await panel.settle();
    await panel.click('General');
    const type = panel.control('Connection type') as HTMLSelectElement;
    expect([...type.options].map((option) => option.value)).toEqual([
      'development',
      'test',
      'production',
      'staging',
    ]);
    const auto = 'Auto-commit: each statement is committed by itself';
    type.value = 'development';
    type.dispatchEvent(new Event('input'));
    await panel.settle();
    expect((panel.control(auto) as HTMLInputElement).checked).toBe(true);
    type.value = 'staging';
    type.dispatchEvent(new Event('input'));
    await panel.settle();
    expect((panel.control(auto) as HTMLInputElement).checked).toBe(false);
  });

  it('asks before a change of structure when its type says so', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'postgres', host: 'db', database: 'shop', type: 'staging' },
      documents: [staging({ autoCommit: true, confirmStructure: true })],
      tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
      responses: {
        'db.split': split,
        'db.execute': () => ({ columns: [], rows: [], affected: 1, elapsedMs: 1 }),
      },
    });
    await run(panel, 'update t set a = 1 where id = 1');
    expect(panel.calls('db.execute')).toHaveLength(1);
    await run(panel, 'create table t (a int)');
    const dialog = panel.dialog();
    expect(dialog.textContent).toContain('This connection asks to confirm changes of structure');
    expect(panel.calls('db.execute')).toHaveLength(1);
  });
});
