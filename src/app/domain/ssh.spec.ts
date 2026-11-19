import {
  emptySshForm,
  readSshProfile,
  sshForm,
  sshPassphraseSecret,
  sshProblem,
  sshProfileValue,
  sshSecret,
} from './ssh';

describe('ssh profiles', () => {
  it('reads a profile from its document and nothing from other documents', () => {
    expect(readSshProfile({ id: 'c', kind: 'connection', name: 'x' })).toBeUndefined();
    expect(
      readSshProfile({
        id: 'p1',
        kind: 'ssh-profile',
        name: 'Bastion',
        value: {
          host: ' bastion ',
          port: 2222,
          username: 'ana',
          auth: 'key',
          passphraseSecret: 's',
        },
      }),
    ).toEqual({
      id: 'p1',
      name: 'Bastion',
      host: 'bastion',
      port: '2222',
      username: 'ana',
      auth: 'key',
      hasPassphrase: true,
    });
    expect(readSshProfile({ id: 'p2', kind: 'ssh-profile', name: 'Old' })).toMatchObject({
      port: '22',
      auth: 'password',
      hasPassphrase: false,
    });
  });

  it('edits a profile without showing its secrets', () => {
    const profile = readSshProfile({
      id: 'p1',
      kind: 'ssh-profile',
      name: 'Bastion',
      value: { host: 'bastion', username: 'ana', auth: 'password' },
    })!;
    expect(sshForm(profile)).toEqual({
      ...emptySshForm(),
      name: 'Bastion',
      host: 'bastion',
      username: 'ana',
      id: 'p1',
      hasPassphrase: false,
    });
  });

  it('says what a profile lacks before it is saved', () => {
    const form = { ...emptySshForm(), host: 'bastion', username: 'ana', password: 'pw' };
    expect(sshProblem({ ...form, host: ' ' }, false)).toBe('Enter the host of the SSH server');
    expect(sshProblem({ ...form, host: 'two words' }, false)).toBe(
      'Enter the host of the SSH server',
    );
    expect(sshProblem({ ...form, port: '70000' }, false)).toBe('Invalid SSH port');
    expect(sshProblem({ ...form, port: '2.5' }, false)).toBe('Invalid SSH port');
    expect(sshProblem({ ...form, username: '' }, false)).toBe('Enter the user of the SSH server');
    expect(sshProblem({ ...form, password: '' }, false)).toBe(
      'Enter the password of the SSH profile',
    );
    expect(sshProblem({ ...form, password: '' }, true)).toBeUndefined();
    expect(sshProblem({ ...form, auth: 'key' }, false)).toBe(
      'Paste the private key of the SSH profile',
    );
    expect(sshProblem({ ...form, port: '' }, false)).toBeUndefined();
  });

  it('stores where and as whom, with the names of its vault secrets', () => {
    const form = { ...emptySshForm(), host: ' bastion ', username: ' ana ', port: '' };
    expect(sshProfileValue('p1', form, true)).toEqual({
      host: 'bastion',
      port: 22,
      username: 'ana',
      auth: 'password',
      secret: sshSecret('p1'),
    });
    expect(sshProfileValue('p1', { ...form, auth: 'key' }, true)).toMatchObject({
      auth: 'key',
      passphraseSecret: sshPassphraseSecret('p1'),
    });
    expect(sshSecret('p1')).toBe('ssh-p1');
    expect(sshPassphraseSecret('p1')).toBe('ssh-p1-passphrase');
  });
});
