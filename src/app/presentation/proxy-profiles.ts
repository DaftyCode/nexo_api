import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { ProxyProfile, emptyProxyForm, proxyForm, proxyPort, proxyProblem } from '../domain/proxy';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * Settings → Proxies: HTTP and SOCKS5 proxies that requests, protocols and database
 * connections choose by name in «Connect through» (DB-25). Passwords stay in the vault.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-proxy-profiles',
  templateUrl: './proxy-profiles.html',
})
export class ProxyProfiles {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  protected readonly profiles = computed(() =>
    this.state.cases.proxies.profiles(this.state.documents()),
  );
  /** The profile in the form: its id, `new`, or none when the form is closed. */
  protected readonly editing = signal<string | undefined>(undefined);
  protected readonly model = signal(emptyProxyForm());
  protected readonly fields = form(this.model);
  private readonly existing = computed(() =>
    this.state.documents().find((document) => document.id === this.editing()),
  );
  /** Whether the profile in the form keeps a password, kept when left blank. */
  protected readonly stored = computed(
    () => !!this.profiles().find((p) => p.id === this.editing())?.hasPassword,
  );
  protected readonly problem = computed(() => proxyProblem(this.model()));
  protected readonly port = proxyPort;

  protected create() {
    this.model.set(emptyProxyForm());
    this.editing.set('new');
  }
  protected edit(profile: ProxyProfile) {
    this.model.set(proxyForm(profile));
    this.editing.set(profile.id);
  }
  protected cancel() {
    this.editing.set(undefined);
  }
  protected save() {
    const editing = this.editing();
    if (!editing || this.problem()) return;
    void this.task.announce('The proxy profile could not be saved', async () => {
      const id = editing === 'new' ? crypto.randomUUID() : editing;
      const saved = await this.state.cases.proxies.save(
        this.state.workspaceId(),
        id,
        this.model(),
        this.existing(),
      );
      this.state.applySaved([saved]);
      this.editing.set(undefined);
      return success('Proxy profile saved', 'toast.proxyProfileSaved', { v0: saved.name });
    });
  }
  protected remove(profile: ProxyProfile) {
    const document = this.state.documents().find((d) => d.id === profile.id);
    if (!document || !this.state.confirm('Delete this proxy profile and its password?')) return;
    void this.task.announce('The proxy profile could not be deleted', async () => {
      await this.state.cases.proxies.remove(document);
      this.state.forget(document);
      return success('Proxy profile deleted', 'toast.proxyProfileDeleted', { v0: profile.name });
    });
  }
}
