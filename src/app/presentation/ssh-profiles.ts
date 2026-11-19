import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { SshTestReport } from '../application/workspace-use-cases/ssh';
import { SshProfile, emptySshForm, sshForm, sshProblem } from '../domain/ssh';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * Settings → SSH: the profiles requests and connections tunnel through. Testing one shows
 * the server's key; an unknown key is trusted here, once, after checking it.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ssh-profiles',
  templateUrl: './ssh-profiles.html',
})
export class SshProfiles {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  protected readonly profiles = computed(() =>
    this.state.cases.ssh.profiles(this.state.documents()),
  );
  /** The profile in the form: its id, `new`, or none when the form is closed. */
  protected readonly editing = signal<string | undefined>(undefined);
  protected readonly model = signal(emptySshForm());
  protected readonly fields = form(this.model);
  /** The last test, of the profile with `id`. */
  protected readonly tested = signal<{ id: string; report: SshTestReport } | undefined>(undefined);
  private readonly existing = computed(() =>
    this.state.documents().find((document) => document.id === this.editing()),
  );
  /** Whether the profile in the form keeps a secret for its way of signing in. */
  protected readonly stored = computed(() => {
    const profile = this.profiles().find((p) => p.id === this.editing());
    return !!profile && profile.auth === this.model().auth;
  });
  protected readonly problem = computed(() => sshProblem(this.model(), this.stored()));

  protected create() {
    this.model.set(emptySshForm());
    this.editing.set('new');
  }
  protected edit(profile: SshProfile) {
    this.model.set(sshForm(profile));
    this.editing.set(profile.id);
  }
  protected cancel() {
    this.editing.set(undefined);
  }
  protected save() {
    const editing = this.editing();
    if (!editing || this.problem()) return;
    void this.task.announce('The SSH profile could not be saved', async () => {
      const id = editing === 'new' ? crypto.randomUUID() : editing;
      const saved = await this.state.cases.ssh.save(
        this.state.workspaceId(),
        id,
        this.model(),
        this.existing(),
      );
      this.state.applySaved([saved]);
      this.editing.set(undefined);
      return success('SSH profile saved', 'toast.sshProfileSaved', { v0: saved.name });
    });
  }
  protected remove(profile: SshProfile) {
    const document = this.state.documents().find((d) => d.id === profile.id);
    if (!document || !this.state.confirm('Delete this SSH profile and its secrets?')) return;
    void this.task.announce('The SSH profile could not be deleted', async () => {
      await this.state.cases.ssh.remove(document);
      this.state.forget(document);
      return success('SSH profile deleted', 'toast.sshProfileDeleted', { v0: profile.name });
    });
  }
  protected test(profile: SshProfile) {
    void this.task.run(async () => {
      this.tested.set(undefined);
      const report = await this.state.cases.ssh.test(this.state.workspaceId(), profile.id);
      this.tested.set({ id: profile.id, report });
    });
  }
  /** Trusts the key the last test showed, then tests again to sign in with it. */
  protected trust(profile: SshProfile, report: SshTestReport) {
    void this.task.run(async () => {
      await this.state.cases.ssh.trust(this.state.workspaceId(), report);
      const again = await this.state.cases.ssh.test(this.state.workspaceId(), profile.id);
      this.tested.set({ id: profile.id, report: again });
    });
  }
}
