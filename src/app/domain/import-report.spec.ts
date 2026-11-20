import { brunoFile, readImportReport } from './import-report';

describe('import reports', () => {
  it('read what the engine says, a kind of note at a time in a fixed order', () => {
    expect(
      readImportReport({
        source: 'thunder',
        requests: 3,
        folders: 1,
        environments: -2,
        notes: [
          { code: 'file', item: 'Upload' },
          { code: 'script', item: 'List' },
          { code: 'file', item: 'Photo' },
          { code: 'unknown', item: 'x' },
          null,
          { code: 'script' },
        ],
      }),
    ).toEqual({
      source: 'Thunder Client',
      requests: 3,
      folders: 1,
      environments: 0,
      notes: [
        { code: 'script', items: ['List', ''] },
        { code: 'file', items: ['Upload', 'Photo'] },
      ],
    });
  });

  it('are absent for imports of other formats', () => {
    expect(readImportReport(undefined)).toBeUndefined();
    expect(readImportReport('report')).toBeUndefined();
    expect(readImportReport({ source: 'postman' })).toBeUndefined();
    expect(readImportReport({ source: 'bruno' })).toEqual({
      source: 'Bruno',
      requests: 0,
      folders: 0,
      environments: 0,
      notes: [],
    });
  });
});

describe('the files of a Bruno folder', () => {
  it('are its .bru files, bruno.json and key files, outside node_modules and hidden folders', () => {
    const read = [
      'pets/bruno.json',
      'pets/users/Get.bru',
      'pets\\keys\\private.PEM',
      'pets/keys/signing.key',
      'pets/package.json',
      'pets/node_modules/x/a.bru',
      'pets/.git/HEAD.bru',
      'pets/notes.md',
    ].filter((path) => brunoFile(path, 10));
    expect(read).toEqual([
      'pets/bruno.json',
      'pets/users/Get.bru',
      'pets\\keys\\private.PEM',
      'pets/keys/signing.key',
    ]);
    expect(brunoFile('pets/huge.bru', 2_000_000)).toBe(false);
  });
});
