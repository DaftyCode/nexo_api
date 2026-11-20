import { ExecutionResponse, WorkspaceDocument } from '../../domain/models';
import { ApiPort } from '../ports';
import { SchemaCases } from './schema';

const response = (body: string) =>
  ({ status: 200, body, headers: [] }) as unknown as ExecutionResponse;
const entry = (id: string, name: string, updated_at: number): WorkspaceDocument => ({
  id,
  workspace_id: 'w',
  kind: 'history',
  name,
  revision: 1,
  updated_at,
  value: null,
});

describe('SchemaCases', () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  const api = {
    async execute<T>(operation: string, payload: Record<string, unknown>) {
      calls.push({ operation, payload });
      return { schema: { type: 'object' }, sampled: (payload['samples'] as unknown[]).length } as T;
    },
  } as unknown as ApiPort;
  const kept: Record<string, ExecutionResponse> = {
    old: response('{"n":1}'),
    new: response('{"n":2}'),
    other: response('{"x":1}'),
  };
  const cases = new SchemaCases(api, async (document) => {
    if (!kept[document.id]) throw new Error('gone');
    return kept[document.id];
  });
  const history = [
    entry('old', 'GET /a', 1),
    entry('gone', 'GET /a', 2),
    entry('new', 'GET /a', 3),
    entry('other', 'GET /b', 4),
  ];

  beforeEach(() => (calls.length = 0));

  it('reads the response shown and the history of the same request, newest first', async () => {
    const inferred = await cases.infer('w', response('{"n":0}'), history, 'GET /a', true);
    expect(inferred.sampled).toBe(3);
    expect(calls).toEqual([
      {
        operation: 'schema.infer',
        payload: { workspace: 'w', samples: [{ n: 0 }, { n: 2 }, { n: 1 }], enums: true },
      },
    ]);
    await cases.infer('w', response('[]'), [], 'GET /a', false);
    expect(calls[1].payload).toEqual({ workspace: 'w', samples: [[]] });
  });

  it('says when the response is not JSON', async () => {
    await expect(cases.infer('w', response('<p>'), history, 'GET /a', false)).rejects.toThrow(
      'This response is not complete JSON',
    );
    expect(calls).toEqual([]);
  });
});
