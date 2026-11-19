import { ExecutionResponse, WorkspaceDocument } from '../../domain/models';
import { CompareCases } from './compare';

const response = (body: string): ExecutionResponse => ({
  status: 200,
  statusText: 'OK',
  headers: [],
  body,
  time: 1,
  size: body.length,
  assertions: [],
  logs: [],
});
const document = (id: string, kind: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind,
  name: id,
  revision: 1,
  updated_at: 1,
  value,
});

function setup(stored: Record<string, unknown> = {}) {
  const calls: { operation: string; payload: unknown }[] = [];
  const api = {
    execute: async (operation: string, payload: unknown) => {
      calls.push({ operation, payload });
      return { same: true };
    },
    document: async (id: string) => document(id, 'history', stored[id]),
  };
  return { cases: new CompareCases(api as never), calls };
}

describe('CompareCases', () => {
  it('asks the backend what changed, with what is left out only when there is some', async () => {
    const { cases, calls } = setup();
    expect(await cases.compare('local', response('{"a":1}'), response('{"a":2}'))).toEqual({
      same: true,
    });
    expect(calls[0]).toEqual({
      operation: 'response.compare',
      payload: {
        workspace: 'local',
        source: { status: 200, statusText: 'OK', headers: [], body: '{"a":1}' },
        target: { status: 200, statusText: 'OK', headers: [], body: '{"a":2}' },
      },
    });
    await cases.compare('local', response(''), response(''), ['updatedAt'], ['Date']);
    expect(calls[1].payload).toMatchObject({ ignore: ['updatedAt'], ignoreHeaders: ['Date'] });
  });

  it('reads the response of a history entry and the responses of a run when chosen', async () => {
    const { cases } = setup({
      h1: { response: response('kept') },
      h2: { request: {} },
      r1: { results: [response('first')], state: 'completed' },
    });
    expect((await cases.historyResponse(document('h1', 'history', null))).body).toBe('kept');
    expect(
      (await cases.historyResponse(document('x', 'history', { response: response('here') }))).body,
    ).toBe('here');
    await expect(cases.historyResponse(document('h2', 'history', null))).rejects.toThrow(
      'This history entry has no response',
    );
    const run = await cases.run(document('r1', 'run', undefined));
    expect(run).toMatchObject({ id: 'r1', state: 'completed', assertions: [], logs: [] });
    expect(run.results[0].body).toBe('first');
    expect((await cases.run(document('r2', 'run', undefined))).results).toEqual([]);
  });
});
