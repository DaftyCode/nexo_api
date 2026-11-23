import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { NATIVE_FILES } from '../composition/providers';
import { sharedFileName, sharedPath } from '../domain/shared';
import { SharedState } from './shared-state';
import { WorkspaceState, success } from './workspace-state';

/** What the dialog's fields hold. */
interface SharedForm {
  path: string;
  key: string;
  encrypt: boolean;
  environments: string[];
}
const empty = (): SharedForm => ({ path: '', key: '', encrypt: true, environments: [] });

/**
 * The dialog of the collections shared by the team (C-01): bringing one in from its file
 * (with the team key when it is sealed), sharing one (where its file goes, sealed or not, and
 * the environments that go with it, then the team key to give), or how one is shared (its
 * file, what both people changed to choose, reload, the team key again, stop sharing). Each
 * mode says how sharing works.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-shared-dialog',
  templateUrl: './shared-dialog.html',
  styleUrl: './shared-dialog.scss',
})
export class SharedDialog {
  protected readonly shared = inject(SharedState);
  protected readonly state = inject(WorkspaceState);
  private readonly files = inject(NATIVE_FILES, { optional: true });
  protected readonly chooses = !!this.files?.available;
  protected readonly model = signal<SharedForm>(empty());
  protected readonly fields = form(this.model);
  protected readonly error = signal('');
  /** The team key of a collection just shared, or asked for again. */
  protected readonly key = signal('');
  protected readonly collection = computed(() => {
    const dialog = this.shared.dialog();
    const id = dialog && 'collection' in dialog ? dialog.collection : '';
    return this.state.collections().find((document) => document.id === id);
  });
  protected readonly link = computed(() =>
    this.shared.byCollection().get(this.collection()?.id ?? ''),
  );

  constructor() {
    effect(() => {
      const dialog = this.shared.dialog();
      untracked(() => {
        this.error.set('');
        this.key.set('');
        const name = this.collection()?.name;
        this.model.set({
          ...empty(),
          path: dialog?.mode === 'share' && name ? sharedFileName(name) : '',
        });
      });
    });
  }

  protected close() {
    this.shared.dialog.set(undefined);
  }

  private async attempt(action: () => Promise<void>) {
    this.error.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(this.state.describe(error));
    }
  }

  /** The file, chosen in the desktop dialog: to open, or where to save. */
  protected async choose() {
    const saving = this.shared.dialog()?.mode === 'share';
    const proposed = sharedFileName(this.collection()?.name ?? '');
    const path = await this.files?.choose(saving ? 'save' : 'open', saving ? proposed : undefined);
    if (path) this.model.update((model) => ({ ...model, path }));
  }

  protected toggleEnvironment(id: string, on: boolean) {
    this.model.update((model) => ({
      ...model,
      environments: on
        ? [...model.environments, id]
        : model.environments.filter((each) => each !== id),
    }));
  }

  protected bringIn() {
    return this.attempt(async () => {
      const { path, key } = this.model();
      await this.shared.link(sharedPath(path), key);
      this.state.tell(success('Shared collection brought in'));
      this.close();
    });
  }

  protected share() {
    return this.attempt(async () => {
      const collection = this.collection();
      if (!collection) return;
      const { path, encrypt, environments } = this.model();
      const key = await this.shared.share(collection.id, sharedPath(path), encrypt, environments);
      this.state.tell(success('Collection shared with the team'));
      if (key) this.key.set(key);
      else this.close();
    });
  }

  protected reload() {
    return this.attempt(async () => {
      await this.shared.sync(this.collection()!.id);
      this.state.tell(success('Reloaded from the shared file'));
    });
  }

  protected resolve(id: string, keep: 'mine' | 'theirs') {
    return this.attempt(() => this.shared.resolve(this.collection()!.id, id, keep));
  }

  protected showKey() {
    return this.attempt(async () => this.key.set(await this.shared.key(this.collection()!.id)));
  }

  protected copyKey() {
    void globalThis.navigator?.clipboard?.writeText(this.key());
    this.state.tell(success('Copied to the clipboard'));
  }

  protected unlink() {
    if (
      !this.state.confirm(
        'Stop sharing this collection? It stays here and its file stays for the team.',
      )
    )
      return;
    return this.attempt(async () => {
      await this.shared.unlink(this.collection()!.id);
      this.state.tell(success('The collection is no longer shared'));
      this.close();
    });
  }
}
