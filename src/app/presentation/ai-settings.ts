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
import { AI } from '../composition/providers';
import {
  AI_EFFORTS,
  AI_PROVIDERS,
  AiProvider,
  AiSettings,
  aiMissing,
  withProvider,
} from '../domain/ai';
import { AiLocal } from './ai-local';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/** What the form holds: the settings and a key typed now, which goes to the vault. */
interface AiForm extends AiSettings {
  key: string;
}

/**
 * Settings → AI assistant (IA-01): off until it is turned on; the provider, its key (kept in
 * the vault, never shown again), the model from the provider's own list, the effort and the
 * proxy the calls go through. It says what leaves the computer before the first use.
 */
@Component({
  imports: [TranslocoPipe, FormField, AiLocal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-settings',
  templateUrl: './ai-settings.html',
})
export class AiSettingsPanel {
  private readonly ai = inject(AI);
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  /** The settings were saved. */
  readonly saved = output<void>();
  protected readonly providers = AI_PROVIDERS;
  protected readonly efforts = AI_EFFORTS;
  protected readonly model = signal<AiForm>({ ...this.ai.settings(), key: '' });
  protected readonly fields = form(this.model);
  /** Whether the vault keeps a key of the provider chosen. */
  protected readonly hasKey = signal(false);
  protected readonly models = signal<{ id: string; name: string }[]>([]);
  /** The model chosen when the provider's list does not have it, kept as one more option. */
  protected readonly unlisted = computed(() => {
    const chosen = this.model().model;
    return this.models().some((model) => model.id === chosen) ? undefined : chosen;
  });
  protected readonly proxies = computed(() =>
    this.state.cases.proxies.profiles(this.state.documents()),
  );
  protected readonly missing = computed(() => {
    const form = this.model();
    return aiMissing(form, this.hasKey() || !!form.key.trim());
  });
  private provider: AiProvider = this.model().provider;

  constructor() {
    // Another provider: its first model, and whether its key is kept.
    effect(() => {
      const provider = this.model().provider;
      untracked(() => {
        if (provider !== this.provider) {
          this.provider = provider;
          this.model.update((form) => ({ ...withProvider(form, provider), key: '' }));
          this.models.set([]);
        }
        void this.ai.hasKey(provider).then((kept) => this.hasKey.set(kept));
      });
    });
  }

  protected loadModels() {
    void this.task.announce('The models could not be listed', async () => {
      await this.saveKey();
      const models = await this.ai.models(this.settings(), this.state.workspaceId());
      this.models.set(models);
      return success('Models listed', 'ai.toast.models', { v0: String(models.length) });
    });
  }

  private settings(): AiSettings {
    const { key: _key, ...settings } = this.model();
    return settings;
  }
  /** A key typed now goes to the vault and leaves the form. */
  private async saveKey() {
    const key = this.model().key.trim();
    if (!key) return;
    await this.ai.saveKey(this.model().provider, key);
    this.model.update((form) => ({ ...form, key: '' }));
    this.hasKey.set(true);
  }

  protected save() {
    void this.task.announce('The assistant could not be saved', async () => {
      await this.saveKey();
      this.ai.saveSettings(this.settings());
      this.saved.emit();
      return success('Assistant saved', 'ai.toast.saved');
    });
  }

  protected removeKey() {
    if (!this.state.confirm('Delete the key of this provider from the vault?')) return;
    void this.task.announce('The key could not be deleted', async () => {
      await this.ai.removeKey(this.model().provider);
      this.hasKey.set(false);
      return success('Key deleted', 'ai.toast.keyDeleted');
    });
  }

  /** A model as the list shows it: its name, and its id when the name is another. */
  protected named(model: { id: string; name: string }) {
    return model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id;
  }
}
