import { SHELL_HISTORY, confirmationAsked, readHistory, remember, shellWords } from './mongo-shell';

describe('MongoDB shell', () => {
  it('suggests commands, collections and their methods', () => {
    const words = shellWords(['orders', 'my-items']);
    expect(words).toContain('show collections');
    expect(words).toContain('db.getSiblingDB');
    expect(words).toContain('db.orders');
    expect(words).toContain('db.orders.find');
    expect(words).toContain("db.getCollection('my-items').drop");
  });

  it('reads the name a destructive command needs', () => {
    expect(confirmationAsked('Type the name of the collection to confirm: orders')).toEqual({
      what: 'collection',
      name: 'orders',
    });
    expect(confirmationAsked('Type the name of the database to confirm: shop')?.what).toBe(
      'database',
    );
    expect(confirmationAsked('No server answered')).toBeUndefined();
  });

  it('keeps a bounded history without repeating the last command', () => {
    let history = remember([], ' db.a.find() ');
    history = remember(history, 'db.a.find()');
    history = remember(history, '');
    expect(history).toEqual(['db.a.find()']);
    const long = Array.from({ length: SHELL_HISTORY + 5 }, (_, n) => `c${n}`);
    expect(long.reduce(remember, [] as string[])).toHaveLength(SHELL_HISTORY);
    expect(readHistory(JSON.stringify(['a', 1, 'b']))).toEqual(['a', 'b']);
    expect(readHistory('not json')).toEqual([]);
    expect(readHistory(undefined)).toEqual([]);
  });
});
