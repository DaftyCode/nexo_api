import {
  DEFAULT_KEEP,
  MASKING_SAMPLE,
  emptyMaskingForm,
  emptyRule,
  maskingForm,
  maskingProblem,
  maskingRules,
  maskingValue,
  readMaskingSet,
} from './masking';

const document = (value: unknown, kind = 'masking') => ({ id: 'm1', kind, name: 'PII', value });

describe('masking sets', () => {
  it('reads a set from its document, with unknown values set to their defaults', () => {
    expect(readMaskingSet(document({}, 'collection'))).toBeUndefined();
    expect(readMaskingSet(document(undefined))).toEqual({
      id: 'm1',
      name: 'PII',
      agents: false,
      rules: [],
    });
    expect(
      readMaskingSet(
        document({
          agents: true,
          rules: [
            { path: 'email', method: 'hash' },
            { path: 'card', method: 'truncate', keep: 2 },
            { path: 7, method: 'shred' },
            null,
          ],
        }),
      ),
    ).toEqual({
      id: 'm1',
      name: 'PII',
      agents: true,
      rules: [
        { path: 'email', method: 'hash', keep: DEFAULT_KEEP },
        { path: 'card', method: 'truncate', keep: 2 },
        { path: '', method: 'hide', keep: DEFAULT_KEEP },
        { path: '', method: 'hide', keep: DEFAULT_KEEP },
      ],
    });
  });

  it('edits a copy of a set, with one rule to fill in when it has none', () => {
    const set = readMaskingSet(document({ rules: [{ path: 'a', method: 'remove' }] }))!;
    const form = maskingForm(set);
    form.rules[0].path = 'b';
    expect(set.rules[0].path).toBe('a');
    expect(maskingForm({ ...set, rules: [] }).rules).toEqual([emptyRule()]);
    expect(emptyMaskingForm()).toEqual({ name: '', agents: false, rules: [emptyRule()] });
  });

  it('stores the rules with a path, and the characters kept only to truncate', () => {
    const rules = [
      { path: ' email ', method: 'hash' as const, keep: 4 },
      { path: '  ', method: 'hide' as const, keep: 4 },
      { path: 'card', method: 'truncate' as const, keep: 3.7 },
    ];
    expect(maskingRules(rules)).toEqual([
      { path: 'email', method: 'hash' },
      { path: 'card', method: 'truncate', keep: 3 },
    ]);
    expect(maskingValue({ name: 'x', agents: true, rules })).toEqual({
      agents: true,
      rules: maskingRules(rules),
    });
  });

  it('says what keeps a set from being saved', () => {
    const form = (change: Partial<ReturnType<typeof emptyMaskingForm>>) => ({
      ...emptyMaskingForm(),
      name: 'PII',
      rules: [{ path: 'email', method: 'hide' as const, keep: 4 }],
      ...change,
    });
    expect(maskingProblem(form({ name: ' ' }))).toBe('Name the masking set');
    expect(maskingProblem(form({ rules: [emptyRule()] }))).toBe(
      'Add a rule with the path of a field',
    );
    expect(
      maskingProblem(
        form({ rules: Array.from({ length: 201 }, () => ({ ...emptyRule(), path: 'a' })) }),
      ),
    ).toBe('A masking set has 200 rules at most');
    expect(maskingProblem(form({ rules: [{ path: 'a', method: 'truncate', keep: 13 }] }))).toBe(
      'Truncate keeps from 0 to 12 characters',
    );
    expect(maskingProblem(form({ rules: [{ path: 'a', method: 'truncate', keep: -1 }] }))).toBe(
      'Truncate keeps from 0 to 12 characters',
    );
    expect(maskingProblem(form({}))).toBeUndefined();
  });

  it('offers an example with the fields that usually need masking', () => {
    const [sample] = JSON.parse(MASKING_SAMPLE);
    expect(Object.keys(sample)).toEqual(['id', 'name', 'email', 'phone', 'card', 'password']);
  });
});
