import { ModulesUseCases } from './modules-use-cases';
import { ExecutionPort, PreferencePort } from './ports';
import { InstallProgress, ModuleSummary, connectionsOf, percent } from '../domain/modules';

const module = (state: ModuleSummary['state']): ModuleSummary => ({
  id: 'postgres',
  name: 'PostgreSQL',
  description: '',
  version: '1.0.0',
  state,
  downloadSize: 4_000_000,
  size: 9_000_000,
  licenses: ['MIT'],
  source: 'https://github.com/o/r/releases/download/v1.0.0/postgres.gz',
  bundled: false,
});
const progress = (state: InstallProgress['state'], received = 0, error?: string) => ({
  id: 'postgres',
  state,
  received,
  total: 100,
  ...(error ? { error } : {}),
});

/** Answers each operation from a queue, and records what was asked. */
function fixture(answers: Record<string, unknown[]>) {
  const calls: [string, unknown][] = [];
  const api = {
    execute: async (operation: string, payload: unknown) => {
      calls.push([operation, payload]);
      const queue = answers[operation] ?? [];
      return queue.length > 1 ? queue.shift() : queue[0];
    },
  } as unknown as ExecutionPort;
  const stored = new Map<string, string>();
  const preferences: PreferencePort = {
    read: (key) => stored.get(key),
    write: (key, value) => (value ? stored.set(key, value) : stored.delete(key)),
  };
  const files = { readBase64: async (file: File) => `base64:${file.name}` };
  const modules = new ModulesUseCases(api, files, preferences, async () => undefined);
  return { modules, calls };
}

describe('ModulesUseCases', () => {
  it('follows an installation until it is installed', async () => {
    const { modules, calls } = fixture({
      'modules.install': [progress('downloading')],
      'modules.progress': [
        progress('downloading', 40),
        progress('verifying', 100),
        progress('installed', 100),
      ],
    });
    const seen: number[] = [];
    await modules.install('postgres', (state) => seen.push(percent(state)));
    expect(seen).toEqual([0, 40, 100, 100]);
    expect(calls.map(([operation]) => operation)).toEqual([
      'modules.install',
      'modules.progress',
      'modules.progress',
      'modules.progress',
    ]);
  });

  it('rejects with the reason of a failed installation', async () => {
    const { modules } = fixture({
      'modules.install': [progress('downloading')],
      'modules.progress': [progress('failed', 0, 'The file is damaged')],
    });
    await expect(modules.install('postgres')).rejects.toThrowError('The file is damaged');
  });

  it('installs a chosen file in base64', async () => {
    const { modules, calls } = fixture({ 'modules.install.file': [module('installed')] });
    const installed = await modules.installFile(new File(['x'], 'postgres.gz'));
    expect(installed.state).toBe('installed');
    expect(calls).toEqual([['modules.install.file', { content: 'base64:postgres.gz' }]]);
  });

  it('says what a connection needs, and updates by itself only when asked to', async () => {
    const ready = fixture({ 'modules.list': [[module('installed')]] });
    expect(await ready.modules.ensure('postgres')).toEqual({ ready: true });

    const missing = fixture({ 'modules.list': [[module('available')]] });
    expect(await missing.modules.ensure('postgres')).toEqual({
      ready: false,
      module: module('available'),
    });
    await expect(missing.modules.ensure('oracle')).rejects.toThrowError(/no oracle module/);

    const outdated = fixture({
      'modules.list': [[module('outdated')]],
      'modules.install': [progress('installed', 100)],
    });
    expect((await outdated.modules.ensure('postgres')).ready).toBe(false);
    outdated.modules.setAutoUpdate(true);
    expect(outdated.modules.autoUpdate()).toBe(true);
    expect(await outdated.modules.ensure('postgres')).toEqual({ ready: true });
    expect(outdated.calls.at(-1)).toEqual(['modules.install', { id: 'postgres' }]);
    outdated.modules.setAutoUpdate(false);
    expect(outdated.modules.autoUpdate()).toBe(false);
  });

  it('removes a module', async () => {
    const { modules, calls } = fixture({});
    await modules.remove('postgres');
    expect(calls).toEqual([['modules.remove', { id: 'postgres' }]]);
  });
});

describe('modules', () => {
  it('measures a download and counts the connections that use a module', () => {
    expect(percent(progress('downloading', 25))).toBe(25);
    expect(percent({ ...progress('downloading', 5), total: 0 })).toBe(0);
    expect(percent(progress('verifying'))).toBe(100);
    const documents = [
      { kind: 'connection', value: { driver: 'postgres' } },
      { kind: 'connection', value: { uri: 'mongodb://x' } },
      { kind: 'collection', value: { driver: 'postgres' } },
      { kind: 'connection', value: { driver: 'postgres' } },
    ];
    expect(connectionsOf('postgres', documents)).toBe(2);
    expect(connectionsOf('mssql', documents)).toBe(0);
  });
});
