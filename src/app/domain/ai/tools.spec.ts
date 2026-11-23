import { readConversation, stopNote, aiInstructions } from '../ai';
import { readSteps, stepLabel, stepOf } from './tools';

describe('the tools of the assistant', () => {
  it('says what each tool did and what it was about', () => {
    expect(stepLabel('sql_describe_table')).toBe('ai.tool.sql_describe_table');
    expect(stepLabel('anything')).toBe('ai.tool.other');
    expect(
      stepOf('sql_describe_table', { connection: 'Prod', path: ['public', 'orders'] }),
    ).toEqual({ tool: 'sql_describe_table', detail: 'public.orders' });
    expect(
      stepOf('mongo_find', { connection: 'M', database: 'shop', collection: 'orders' }),
    ).toEqual({ tool: 'mongo_find', detail: 'shop.orders' });
    expect(stepOf('read_request', { name: 'Login' }).detail).toBe('Login');
    expect(stepOf('sql_query', { connection: 'Prod', sql: 'SELECT 1' }).detail).toBe('Prod');
    expect(stepOf('read_open', 'not an object')).toEqual({ tool: 'read_open' });
  });

  it('keeps the steps of a message, leaving out what is not one', () => {
    expect(readSteps('x')).toBeUndefined();
    expect(readSteps([])).toBeUndefined();
    expect(
      readSteps([{ tool: 'read_open' }, { tool: 'sql_query', detail: 'Prod', failed: true }, 3]),
    ).toEqual([{ tool: 'read_open' }, { tool: 'sql_query', detail: 'Prod', failed: true }]);
    const kept = readConversation({
      id: 'c',
      name: 'c',
      value: { messages: [{ role: 'assistant', text: 'Ok', steps: [{ tool: 'read_open' }] }] },
    });
    expect(kept.messages[0]?.steps).toEqual([{ tool: 'read_open' }]);
  });

  it('tells the model how its code is used', () => {
    expect(stopNote('tools')).toBe('ai.stop.tools');
    expect(stopNote('empty')).toBe('ai.stop.empty');
    expect(aiInstructions('request')).toContain('read_open');
    expect(aiInstructions('request')).toContain('pm.test');
    expect(aiInstructions('mongo')).toContain('pipeline as an array');
    expect(aiInstructions('sql')).toContain('```sql');
  });
});
