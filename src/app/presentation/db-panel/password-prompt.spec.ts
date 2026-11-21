import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../../application/ports';
import { node, startDbPanel } from '../../testing/db-panel';

const asking = (payload: Record<string, unknown>) => {
  if (!payload['password'])
    throw new ApiFailure('Type the password of the connection', 'database.password', 400, {
      connection: 'Shop',
    });
  return { serverVersion: '18', tls: false };
};

describe('the password of a connection that keeps none', () => {
  it('is asked for when its navigator connects, and the session opens with it', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'postgres', host: 'db', database: 'shop', askPassword: true },
      tree: { '': [node('database', 'shop')] },
      responses: { 'db.connect': asking },
    });
    await panel.open('Shop');
    const dialog = panel.dialog('Password of the connection');
    expect(dialog.textContent).toContain('Type the password of Shop to connect.');
    const field = panel.control('Password', dialog) as HTMLInputElement;
    expect(field.type).toBe('password');
    await panel.fill('Password', 'typed', dialog);
    await panel.click('Connect', dialog);
    expect(panel.calls('db.connect').at(-1)).toMatchObject({ password: 'typed' });
    expect(panel.rows()).toContain('shop');
  });

  it('leaves the connection closed when the person cancels', async () => {
    const panel = await startDbPanel({
      connection: { driver: 'postgres', host: 'db', database: 'shop', askPassword: true },
      responses: { 'db.connect': asking },
    });
    await panel.open('Shop');
    await panel.click('Cancel', panel.dialog('Password of the connection'));
    expect(panel.root().querySelector('[role="dialog"]')).toBeNull();
    expect(panel.text()).toContain('connection failed');
    expect(panel.calls('db.connect')).toHaveLength(1);
  });
});
