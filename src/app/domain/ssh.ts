/**
 * SSH profiles (`ssh-profile` documents): a bastion to tunnel requests and connections
 * through, reused by any of them. The document says where and as whom; the password or the
 * private key and its passphrase are vault secrets under the profile's names.
 */
export type SshAuth = 'password' | 'key';

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  auth: SshAuth;
  /** Whether a passphrase is kept for the key. */
  hasPassphrase: boolean;
}

/** The vault secret with the password or the private key of profile `id`. */
export const sshSecret = (id: string) => `ssh-${id}`;
/** The vault secret with the passphrase of the private key of profile `id`. */
export const sshPassphraseSecret = (id: string) => `ssh-${id}-passphrase`;

const text = (value: unknown) =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

/** A profile from its document; anything else reads as none. */
export function readSshProfile(document: {
  id: string;
  kind: string;
  name: string;
  value?: unknown;
}): SshProfile | undefined {
  if (document.kind !== 'ssh-profile') return undefined;
  const value = (document.value ?? {}) as Record<string, unknown>;
  return {
    id: document.id,
    name: document.name,
    host: text(value['host']),
    port: text(value['port']) || '22',
    username: text(value['username']),
    auth: value['auth'] === 'key' ? 'key' : 'password',
    hasPassphrase: !!text(value['passphraseSecret']),
  };
}

/** What the person fills in: secrets typed now go to the vault; blank keeps the stored ones. */
export interface SshProfileForm {
  name: string;
  host: string;
  port: string;
  username: string;
  auth: SshAuth;
  password: string;
  privateKey: string;
  passphrase: string;
}

export function emptySshForm(): SshProfileForm {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    auth: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
  };
}

export function sshForm(profile: SshProfile): SshProfileForm {
  return { ...emptySshForm(), ...profile, password: '', privateKey: '', passphrase: '' };
}

/** What is missing for a profile to be saved; `stored` when its secret is already kept. */
export function sshProblem(form: SshProfileForm, stored: boolean): string | undefined {
  if (!form.host.trim() || /\s/.test(form.host.trim())) return 'Enter the host of the SSH server';
  const port = Number(form.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Invalid SSH port';
  if (!form.username.trim()) return 'Enter the user of the SSH server';
  const secret = form.auth === 'key' ? form.privateKey : form.password;
  if (!stored && !secret) {
    return form.auth === 'key'
      ? 'Paste the private key of the SSH profile'
      : 'Enter the password of the SSH profile';
  }
  return undefined;
}

/** The document value of a profile: where and as whom, with the names of its secrets. */
export function sshProfileValue(id: string, form: SshProfileForm, passphrase: boolean) {
  return {
    host: form.host.trim(),
    port: Number(form.port || 22),
    username: form.username.trim(),
    auth: form.auth,
    secret: sshSecret(id),
    ...(form.auth === 'key' && passphrase ? { passphraseSecret: sshPassphraseSecret(id) } : {}),
  };
}
