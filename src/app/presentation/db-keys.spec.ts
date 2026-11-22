import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttons, clickButton } from '../testing/controls';
import { KeysPanel, keysPanel } from '../testing/keys-panel';

describe('the keys of a Redis database', () => {
  let panel: KeysPanel;
  let fixture: KeysPanel['fixture'];
  const root = () => panel.root();
  const settle = () => panel.settle();
  const calls = (operation: string) => panel.calls(operation);
  const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
    panel.type(input, text);
  const pick = (select: HTMLSelectElement, value: string) => panel.pick(select, value);
  const row = (label: string) => panel.row(label);
  const open = (label: string) => panel.open(label);

  beforeEach(async () => {
    panel = await keysPanel();
    fixture = panel.fixture;
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens its own session, groups the keys and reads more of them', async () => {
    expect(calls('db.connect').at(-1)).toMatchObject({ session: 'keys:k1', database: 'db0' });
    expect(row('user').getAttribute('aria-expanded')).toBe('false');
    await open('user');
    await open('1');
    expect(row('name').textContent).toContain('5 s');
    await clickButton(fixture, 'Load more');
    expect(calls('db.kv.scan').at(-1)).toMatchObject({ cursor: '42', count: 200 });
    expect(row('z').textContent).toContain('1');
    // A pattern and a type read the keys again from the start.
    await type(root().querySelector('input[aria-label="Pattern"]')!, 'user:*');
    await pick(root().querySelector<HTMLSelectElement>('select[aria-label="Type"]')!, 'hash');
    await clickButton(fixture, 'Search', root().querySelector('.db-keys-filter')!);
    await settle();
    expect(calls('db.kv.scan').at(-1)).toEqual(
      expect.objectContaining({ pattern: 'user:*', type: 'hash' }),
    );
  });

  it('shows and changes a key by its type', async () => {
    await open('user');
    await open('1');
    await open('name');
    const value = root().querySelector<HTMLTextAreaElement>('textarea[aria-label="Value"]')!;
    expect(value.value).toBe('Ana');
    await type(value, 'Eva');
    await clickButton(fixture, 'Save');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'set', value: 'Eva' });
    await type(root().querySelector('input[placeholder="60s, 5m, 2h, 1d"]')!, '5m');
    await clickButton(fixture, 'Set expiry');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'expire', ttlMs: 300_000 });
    await clickButton(fixture, 'Never expire');
    expect(calls('db.kv.write').at(-1)).toEqual(
      expect.not.objectContaining({ ttlMs: expect.anything() }),
    );
    await type(root().querySelector('.kv-actions input:not([placeholder])')!, 'user:1:first');
    await clickButton(fixture, 'Rename');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'rename', to: 'user:1:first' });

    // A hash: its fields, one edited and one removed, more of them read.
    await open('1');
    await open('1');
    const hash = [...root().querySelectorAll<HTMLButtonElement>('.db-keys-row')].find(
      (button) => button.title === 'user:1',
    )!;
    hash.click();
    await settle();
    expect(root().querySelector('.kv-facts')?.textContent).toContain('listpack');
    buttons(root().querySelector('.kv-elements')!, 'Edit')[0].click();
    await settle();
    await type(root().querySelector('.kv-add input[aria-label="Value"]')!, 'Eva');
    await clickButton(fixture, 'Save', root().querySelector('.kv-add')!);
    expect(calls('db.kv.write').at(-1)).toMatchObject({
      action: 'put',
      field: 'name',
      value: 'Eva',
    });
    buttons(root().querySelector('.kv-elements')!, 'Remove')[1].click();
    await settle();
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'remove', field: 'city' });
    await clickButton(fixture, 'Load more', root().querySelector('.db-keys-sheet')!);
    expect(root().querySelector('.kv-elements')?.textContent).toContain('zip');

    // A sorted set, a list and a stream.
    await open('scores');
    buttons(root().querySelector('.kv-elements')!, 'Edit')[0].click();
    await settle();
    await type(root().querySelector('.kv-add input[aria-label="Score"]')!, '9');
    await clickButton(fixture, 'Save', root().querySelector('.kv-add')!);
    expect(calls('db.kv.write').at(-1)).toMatchObject({ score: 9, field: 'ana' });
    await open('queue');
    await type(root().querySelector('.kv-add input[aria-label="Value"]')!, 'b');
    await clickButton(fixture, 'Add');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'put', value: 'b' });
    buttons(root().querySelector('.kv-elements')!, 'Edit')[0].click();
    await settle();
    await clickButton(fixture, 'Cancel', root().querySelector('.kv-add')!);
    await open('events');
    await type(root().querySelector('.kv-add input')!, 'not json');
    await clickButton(fixture, 'Add');
    expect(root().querySelector('.db-keys-error')?.textContent).toContain('JSON object');
    await type(root().querySelector('.kv-add input')!, '{"b": 2}');
    await clickButton(fixture, 'Add');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ fields: [['b', '2']] });
    buttons(root().querySelector('.kv-elements')!, 'Remove')[0].click();
    await settle();
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'remove', field: '1-0' });
    await open('bloom');
    expect(root().querySelector('.db-keys-sheet')?.textContent).toContain('console');

    // A binary value is never rewritten from its text; a key is deleted once confirmed.
    await open('bin');
    expect(root().querySelector('.kv-text')?.textContent).toBe('\\xff\\x00');
    expect(root().querySelector('textarea[aria-label="Value"]')).toBeNull();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = calls('db.kv.write').length;
    await clickButton(fixture, 'Delete key');
    expect(calls('db.kv.write')).toHaveLength(before);
    confirm.mockReturnValue(true);
    await clickButton(fixture, 'Delete key');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ action: 'delete', confirm: true });
    expect(row('bin')).toBeUndefined();
  }, 20_000);

  it('creates keys of each type, never over an existing one', async () => {
    await clickButton(fixture, '＋ Key');
    const form = () => root().querySelector('.kv-new')!;
    await type(form().querySelector('input')!, 'h:new');
    await pick(form().querySelector('select')!, 'hash');
    const inputs = () => form().querySelectorAll('input');
    await type(inputs()[1], 'f');
    await type(inputs()[2], 'v');
    await clickButton(fixture, 'Create');
    expect(calls('db.kv.write').at(-1)).toMatchObject({
      key: 'h:new',
      type: 'hash',
      field: 'f',
      value: 'v',
    });
    await clickButton(fixture, '＋ Key');
    await type(form().querySelector('input')!, 's:new');
    await pick(form().querySelector('select')!, 'stream');
    await type(inputs()[1], '{"a": 1}');
    await clickButton(fixture, 'Create');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ type: 'stream', fields: [['a', '1']] });
    await clickButton(fixture, '＋ Key');
    await pick(form().querySelector('select')!, 'zset');
    await type(form().querySelector('input')!, 'z:new');
    await type(inputs()[2], '2');
    await clickButton(fixture, 'Create');
    expect(calls('db.kv.write').at(-1)).toMatchObject({ type: 'zset', score: 2 });
    await clickButton(fixture, '＋ Key');
    await clickButton(fixture, 'Cancel', form());
    expect(root().querySelector('.kv-new')).toBeNull();
  });
});
