import { WorkspaceDocument } from '../../domain/models';
import {
  SshProfile,
  SshProfileForm,
  readSshProfile,
  sshPassphraseSecret,
  sshProfileValue,
  sshSecret,
} from '../../domain/ssh';
import { ApiPort } from '../ports';

/** What testing a profile tells: the server's key and whether Nexo trusts it yet. */
export interface SshTestReport {
  trusted: boolean;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

/** SSH profiles: workspace documents, their password or key and passphrase in the vault. */
export class SshProfileCases {
  constructor(private readonly api: ApiPort) {}

  /** The profiles among a workspace's documents, by name. */
  profiles(documents: readonly WorkspaceDocument[]): SshProfile[] {
    return documents
      .map(readSshProfile)
      .filter((profile): profile is SshProfile => !!profile)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Saves a profile with its revision. A secret typed now goes to the vault under the
   * profile's names; a blank one keeps what is stored.
   */
  async save(
    workspace: string,
    id: string,
    form: SshProfileForm,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const secret = form.auth === 'key' ? form.privateKey : form.password;
    if (secret) await this.api.putSecret(sshSecret(id), secret);
    let passphrase = !!existing && !!readSshProfile(existing)?.hasPassphrase;
    if (form.auth === 'key' && form.passphrase) {
      await this.api.putSecret(sshPassphraseSecret(id), form.passphrase);
      passphrase = true;
    }
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'ssh-profile',
      name: form.name.trim() || `${form.username.trim()}@${form.host.trim()}`,
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: sshProfileValue(id, form, passphrase),
    });
  }

  /** Deletes a profile and its secrets; routes that named it say it no longer exists. */
  async remove(document: WorkspaceDocument) {
    await this.api.remove(document);
    for (const name of [sshSecret(document.id), sshPassphraseSecret(document.id)])
      await this.api.removeSecret(name).catch(() => undefined);
  }

  /** Signs in to the profile's server once and tells its key. */
  test(workspace: string, profile: string) {
    return this.api.execute<SshTestReport>('ssh.test', { workspace, profile });
  }

  /** Trusts the key the server showed in its last test, as `ssh-keygen` names it. */
  trust(workspace: string, report: SshTestReport) {
    return this.api.execute<{ trusted: boolean }>('ssh.trust', {
      workspace,
      host: report.host,
      port: report.port,
      fingerprint: report.fingerprint,
    });
  }
}
