import { SCRIPT_API, membersAfter, pathBefore } from './script-api';

const names = (steps: Parameters<typeof membersAfter>[0]) =>
  membersAfter(steps)?.map((member) => member.name);

describe('script API suggestions', () => {
  it('read the member path before the cursor, calls included', () => {
    expect(pathBefore('pm.environment.se')).toEqual({
      steps: [
        { name: 'pm', call: false },
        { name: 'environment', call: false },
      ],
      typed: 'se',
      from: 15,
    });
    expect(pathBefore('const a = pm.expect(body.items.map((x) => x.id)).to.')).toMatchObject({
      steps: [
        { name: 'pm', call: false },
        { name: 'expect', call: true },
        { name: 'to', call: false },
      ],
      typed: '',
    });
    expect(pathBefore('nx.response.json().')?.steps.at(-1)).toEqual({ name: 'json', call: true });
    expect(pathBefore('let x = p')).toEqual({ steps: [], typed: 'p', from: 8 });
    // Unbalanced parentheses or a dot with nothing before are not member paths.
    expect(pathBefore('foo).')).toBeUndefined();
    expect(pathBefore('(1 + 2).')).toBeUndefined();
    expect(pathBefore(' .x')).toBeUndefined();
  });

  it('find what can follow a path', () => {
    expect(names([])).toEqual(['pm', 'nx']);
    const api = names([{ name: 'pm', call: false }]);
    expect(api).toEqual(SCRIPT_API.map((member) => member.name));
    expect(names([{ name: 'nx', call: false }])).toEqual(api);
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'environment', call: false },
      ]),
    ).toEqual(['get', 'has', 'toObject', 'replaceIn', 'set', 'unset', 'clear']);
    // The runner data cannot be changed.
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'iterationData', call: false },
      ]),
    ).not.toContain('set');
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'response', call: false },
        { name: 'to', call: false },
        { name: 'have', call: false },
      ]),
    ).toEqual(['status', 'header', 'body', 'jsonBody']);
    const chain = names([
      { name: 'pm', call: false },
      { name: 'expect', call: true },
      { name: 'to', call: false },
      { name: 'not', call: false },
    ]);
    expect(chain).toEqual(expect.arrayContaining(['equal', 'eql', 'include', 'be', 'deep', 'ok']));
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'test', call: false },
      ]),
    ).toEqual(['skip']);
    // A call that returns nothing known, and names that do not exist.
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'response', call: false },
        { name: 'json', call: true },
      ]),
    ).toBeUndefined();
    expect(names([{ name: 'console', call: false }])).toBeUndefined();
    expect(
      names([
        { name: 'pm', call: false },
        { name: 'nothing', call: false },
      ]),
    ).toBeUndefined();
  });

  it('describe every member with how it is used', () => {
    const visit = (members: typeof SCRIPT_API, seen = new Set<object>()): void => {
      for (const member of members) {
        if (seen.has(member)) continue;
        seen.add(member);
        expect(member.doc.length, member.name).toBeGreaterThan(5);
        if (member.kind !== 'object') expect(member.signature, member.name).not.toBe('');
        visit(member.members ?? [], seen);
        visit(member.returns ?? [], seen);
      }
    };
    visit(SCRIPT_API);
  });
});
