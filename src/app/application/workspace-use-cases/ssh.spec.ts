import { WorkspaceDocument } from '../../domain/models';
import { emptySshForm } from '../../domain/ssh';
import { SshProfileCases } from './ssh';

function fakeApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, answer?: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer?.(...args);
    };
  const api = {
    execute: record('execute', (operation) =>
      operation === 'ssh.test'
        ? {
            trusted: false,
            host: 'bastion',
            port: 22,
            algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:x',
          }
        : { trusted: true },
    ),
    save: record('save', (document) => ({
      ...(document as WorkspaceDocument),
      revision: (document as WorkspaceDocument).revision + 1,
    })),
    remove: record('remove'),
    putSecret: record('putSecret'),
    removeSecret: record('removeSecret', (name) => {
      if (String(name).endsWith('passphrase')) throw new Error('Secret not found');
    }),
  };
  return { cases: new SshProfileCases(api as never), calls };
}

const document = (id: string, name: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind: 'ssh-profile',
  name,
  revision: 3,
  updated_at: 9,
  value,
});

describe('SshProfileCases', () => {
  it('lists the profiles among the documents, by name', () => {
    const { cases } = fakeApi();
    const profiles = cases.profiles([
      document('b', 'Zeta', { host: 'z' }),
      { ...document('c', 'Connection', {}), kind: 'connection' },
      document('a', 'Alpha', { host: 'a' }),
    ]);
    expect(profiles.map((profile) => profile.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('saves the secrets typed now in the vault and keeps the stored ones when blank', async () => {
    const { cases, calls } = fakeApi();
    const form = { ...emptySshForm(), host: 'bastion', username: 'ana', password: 'pw' };
    const created = await cases.save('local', 'p1', form);
    expect(created).toMatchObject({
      id: 'p1',
      kind: 'ssh-profile',
      name: 'ana@bastion',
      revision: 1,
      value: { host: 'bastion', port: 22, username: 'ana', auth: 'password', secret: 'ssh-p1' },
    });
    expect(calls[0]).toEqual({ method: 'putSecret', args: ['ssh-p1', 'pw'] });

    calls.length = 0;
    const existing = document('p1', 'Bastion', {
      auth: 'key',
      passphraseSecret: 'ssh-p1-passphrase',
    });
    const key = { ...form, name: ' Jump ', auth: 'key' as const, password: '', privateKey: '' };
    const kept = await cases.save('local', 'p1', key, existing);
    expect(calls.map((call) => call.method)).toEqual(['save']);
    expect(kept).toMatchObject({
      name: 'Jump',
      revision: 4,
      value: { auth: 'key', passphraseSecret: 'ssh-p1-passphrase' },
    });
    await cases.save('local', 'p2', { ...key, privateKey: 'KEY', passphrase: 'phrase' });
    expect(calls.filter((call) => call.method === 'putSecret').map((call) => call.args)).toEqual([
      ['ssh-p2', 'KEY'],
      ['ssh-p2-passphrase', 'phrase'],
    ]);
  });

  it('removes a profile with its secrets, even when one was never stored', async () => {
    const { cases, calls } = fakeApi();
    await cases.remove(document('p1', 'Bastion', {}));
    expect(calls.map((call) => [call.method, call.args[0]])).toEqual([
      ['remove', expect.objectContaining({ id: 'p1' })],
      ['removeSecret', 'ssh-p1'],
      ['removeSecret', 'ssh-p1-passphrase'],
    ]);
  });

  it('tests a profile and trusts the key its server showed', async () => {
    const { cases, calls } = fakeApi();
    const report = await cases.test('local', 'p1');
    expect(calls[0].args).toEqual(['ssh.test', { workspace: 'local', profile: 'p1' }]);
    await cases.trust('local', report);
    expect(calls[1].args).toEqual([
      'ssh.trust',
      { workspace: 'local', host: 'bastion', port: 22, fingerprint: 'SHA256:x' },
    ]);
  });
});
