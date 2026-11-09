import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { INTEGRATION } from '../composition/providers';
import { GitInput, GitResult } from '../application/integration-use-cases';
import { GitRemote, RepositoryImport, repositoryName } from '../domain/repository';
import { PanelTask } from './panel-task';
import { WorkspaceState } from './workspace-state';

type SyncOperation = 'fetch' | 'pull' | 'push';

/** Git's own output, or what it said when it failed. */
function resultText(result: GitResult) {
  return (
    [result.stdout, result.stderr].filter(Boolean).join('\n').trim() ||
    (result.success ? 'Done.' : 'Git reported an error.')
  );
}

/**
 * The remotes of a workspace Git project: add and remove them, fetch, pull and push, and
 * clone a repository into a new workspace. Git signs in with the person's credential manager
 * or SSH agent; Nexo never stores credentials.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-git-remotes',
  styleUrl: './git-remotes.scss',
  templateUrl: './git-remotes.html',
})
export class GitRemotes {
  protected readonly state = inject(WorkspaceState);
  private readonly integration = inject(INTEGRATION);
  protected readonly task = new PanelTask(this.state);
  /** Git's output of the last operation, for the panel's output area. */
  readonly result = output<string>();
  protected readonly remotes = signal<GitRemote[]>([]);
  protected readonly model = signal({
    remote: 'origin',
    url: '',
    rebase: false,
    forceWithLease: false,
    cloneUrl: '',
    cloneName: '',
  });
  protected readonly fields = form(this.model);
  protected readonly suggestedName = computed(() =>
    this.model().cloneUrl.trim() ? repositoryName(this.model().cloneUrl) : '',
  );
  /** A Git error: the advice, which is translated, and Git's own words below it. */
  protected readonly errorParts = computed(() => {
    const [advice, ...details] = this.task.error().split('\n\n');
    return { advice, details: details.join('\n\n') };
  });

  constructor() {
    effect(() => {
      const workspace = this.state.workspaceId();
      untracked(() => void this.loadRemotes(workspace));
    });
  }

  /** The remotes, or none while the project has no repository yet. */
  protected async loadRemotes(workspace = this.state.workspaceId()) {
    try {
      this.remotes.set(await this.integration.remotes(workspace));
    } catch {
      this.remotes.set([]);
    }
  }
  protected addRemote() {
    void this.task.run(async () => {
      const { remote, url } = this.model();
      const result = await this.git('remote.add', { remote: remote.trim(), url: url.trim() });
      if (result.success) this.model.update((m) => ({ ...m, url: '' }));
      await this.loadRemotes();
    });
  }
  protected removeRemote(name: string) {
    if (!this.state.confirm('Remove this remote? Its address is forgotten; the repository stays.'))
      return;
    void this.task.run(async () => {
      await this.git('remote.remove', { remote: name });
      await this.loadRemotes();
    });
  }
  protected sync(operation: SyncOperation) {
    const { remote, rebase, forceWithLease } = this.model();
    if (
      operation === 'push' &&
      forceWithLease &&
      !this.state.confirm(
        'Replace the remote branch with yours? The push stops if the remote has commits you have not fetched.',
      )
    )
      return;
    void this.task.run(async () => {
      const workspace = this.state.workspaceId();
      const input: GitInput = { remote: remote.trim() || 'origin' };
      if (operation === 'pull' && rebase) input.rebase = true;
      if (operation === 'push' && forceWithLease) input.forceWithLease = true;
      const result = await this.git(operation, input);
      if (operation === 'pull' && result.success) {
        const imported = await this.integration.importRepository(workspace, this.state.documents());
        await this.state.refresh();
        this.state.notice.set('Collections updated from the repository');
        this.result.emit(`${resultText(result)}\n\n${this.summary(imported)}`);
      }
    });
  }
  /** Clones into a new workspace and opens it; a clone that fails leaves no workspace. */
  protected clone() {
    void this.task.run(async () => {
      const { cloneUrl, cloneName } = this.model();
      const url = cloneUrl.trim();
      if (!url) throw new Error('Write the address of the repository to clone');
      const name = cloneName.trim() || repositoryName(url);
      const created = await this.state.cases.createWorkspace(name);
      let imported: RepositoryImport;
      try {
        const result = await this.integration.git(created.id, 'clone', { url });
        if (!result.success) throw new Error(resultText(result));
        imported = await this.integration.importRepository(created.id, []);
      } catch (error) {
        await this.state.cases.deleteWorkspace(created.id).catch(() => undefined);
        throw error;
      }
      this.model.update((m) => ({ ...m, cloneUrl: '', cloneName: '' }));
      await this.state.openWorkspace(created.id);
      this.state.notice.set('Repository cloned into a new workspace');
      this.result.emit(this.summary(imported));
    });
  }
  private summary(imported: RepositoryImport) {
    return `Collections: ${imported.added} added, ${imported.updated} updated, ${imported.unchanged} unchanged${imported.skipped ? `, ${imported.skipped} skipped` : ''}.`;
  }
  private async git(operation: Parameters<typeof this.integration.git>[1], input: GitInput) {
    const result = await this.integration.git(this.state.workspaceId(), operation, input);
    this.result.emit(resultText(result));
    return result;
  }
}
