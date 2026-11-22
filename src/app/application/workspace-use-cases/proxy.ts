import { WorkspaceDocument } from '../../domain/models';
import {
  ProxyProfile,
  ProxyProfileForm,
  proxyProfileValue,
  proxySecret,
  readProxyProfile,
} from '../../domain/proxy';
import { ApiPort } from '../ports';

/** Proxy profiles: workspace documents, their password in the vault. */
export class ProxyProfileCases {
  constructor(private readonly api: ApiPort) {}

  /** The profiles among a workspace's documents, by name. */
  profiles(documents: readonly WorkspaceDocument[]): ProxyProfile[] {
    return documents
      .map(readProxyProfile)
      .filter((profile): profile is ProxyProfile => !!profile)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Saves a profile with its revision. A password typed now goes to the vault under the
   * profile's name; a blank one keeps what is stored while the profile keeps a user.
   */
  async save(
    workspace: string,
    id: string,
    form: ProxyProfileForm,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    const user = !!form.username.trim();
    if (user && form.password) await this.api.putSecret(proxySecret(id), form.password);
    const kept = !!existing && !!readProxyProfile(existing)?.hasPassword;
    if (!user && kept) await this.api.removeSecret(proxySecret(id)).catch(() => undefined);
    return this.api.save({
      id,
      workspace_id: workspace,
      kind: 'proxy-profile',
      name: form.name.trim() || `${form.host.trim()}${form.port.trim() ? ':' + form.port : ''}`,
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: proxyProfileValue(id, form, user && (!!form.password || kept)),
    });
  }

  /** Deletes a profile and its password; routes that named it say it no longer exists. */
  async remove(document: WorkspaceDocument) {
    await this.api.remove(document);
    await this.api.removeSecret(proxySecret(document.id)).catch(() => undefined);
  }
}
