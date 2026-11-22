import { beforeEach, describe, expect, it } from 'vitest';
import { clickButton } from '../testing/controls';
import { KeysPanel, keysPanel } from '../testing/keys-panel';

describe('the console and the server of a Redis database', () => {
  let panel: KeysPanel;
  let fixture: KeysPanel['fixture'];
  const root = () => panel.root();
  const calls = (operation: string) => panel.calls(operation);
  const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
    panel.type(input, text);
  const settle = () => panel.settle();

  beforeEach(async () => {
    panel = await keysPanel();
    fixture = panel.fixture;
  });

  it('runs commands in the console, a dangerous one once its name is typed', async () => {
    await clickButton(fixture, 'Console');
    const line = () => root().querySelector<HTMLInputElement>('input[aria-label="Command"]')!;
    await type(line(), 'hg');
    expect(root().querySelectorAll('#kv-commands option')).toHaveLength(2);
    await type(line(), 'SET k v');
    expect(root().querySelector('.kv-syntax')?.textContent).toContain('KEEPTTL');
    await clickButton(fixture, 'Run');
    expect(root().querySelector('.kv-answer')?.textContent).toBe('"OK"');
    await type(line(), 'BAD');
    await clickButton(fixture, 'Run');
    expect(root().querySelectorAll('.kv-answer.failed')).toHaveLength(1);
    // The history, with the arrow keys.
    line().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await settle();
    expect(line().value).toBe('BAD');
    line().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await settle();
    expect(line().value).toBe('SET k v');
    line().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    line().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await settle();
    expect(line().value).toBe('');
    await type(line(), 'FLUSHDB');
    await clickButton(fixture, 'Run');
    expect(root().querySelector('.db-keys-confirm')?.textContent).toContain('FLUSHDB');
    await type(root().querySelector('input[aria-label="Command name"]')!, 'FLUSHDB');
    await clickButton(fixture, 'Run', root().querySelector('.db-keys-confirm')!);
    expect(calls('db.kv.command').at(-1)).toMatchObject({
      line: 'FLUSHDB',
      confirmName: 'FLUSHDB',
    });
    expect(root().querySelector('.db-keys-confirm')).toBeNull();
    await clickButton(fixture, 'Clear');
    expect(root().querySelector('.kv-answer')).toBeNull();
  });

  it('shows the server: its information, clients and slow commands', async () => {
    await clickButton(fixture, 'Server');
    expect(root().textContent).toContain('redis_version');
    expect(root().querySelector('.kv-table')?.textContent).toContain('127.0.0.1:5');
    expect(root().querySelector('.kv-slow')?.textContent).toContain('KEYS');
    await clickButton(fixture, 'Disconnect', root().querySelector('.kv-table')!);
    expect(calls('db.kv.command').at(-1)).toMatchObject({ line: 'CLIENT KILL ID 3' });
    await clickButton(fixture, 'Refresh');
    expect(calls('db.kv.command').filter((call) => call['line'] === 'INFO')).toHaveLength(2);
  });
});
