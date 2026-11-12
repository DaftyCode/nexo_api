import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  WritableSignal,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { INTEGRATION } from '../composition/providers';
import { SecretSummary, formatAllowedDomains } from '../domain/secrets';
import { PanelTask } from './panel-task';
import { named, success } from './workspace-state';

/**
 * The secrets of the vault: saved, changed or removed, with the domains they may go to. It
 * belongs to the panel, so the form keeps what was typed across its tabs.
 */
export class VaultForm {
  private readonly integration = inject(INTEGRATION);
  readonly model = signal({ secretName: 'api_token', secretValue: '', secretDomains: '' });
  readonly fields = form(this.model);
  readonly secrets = signal<SecretSummary[]>([]);
  private readonly secretName = computed(() => this.model().secretName);
  readonly formatDomains = formatAllowedDomains;

  constructor(
    private readonly task: PanelTask,
    private readonly output: WritableSignal<string>,
  ) {
    // Typing a saved secret's name shows its allowed domains, so saving a new value keeps them.
    // It reacts to the name only, never to the domains being edited.
    effect(() => {
      const name = this.secretName();
      const saved = this.secrets().find((secret) => secret.name === name);
      if (!saved) return;
      const domains = formatAllowedDomains(saved.allowedHosts);
      untracked(() => {
        if (this.model().secretDomains !== domains)
          this.model.update((m) => ({ ...m, secretDomains: domains }));
      });
    });
  }

  async loadSecrets() {
    try {
      this.secrets.set(await this.integration.secrets());
    } catch {
      this.secrets.set([]);
    }
  }
  /** Loads a saved secret into the form to change its value or allowed domains. */
  editSecret(secret: SecretSummary) {
    this.model.update((m) => ({
      ...m,
      secretName: secret.name,
      secretValue: '',
      secretDomains: formatAllowedDomains(secret.allowedHosts),
    }));
  }
  secret(remove = false, name = this.model().secretName) {
    void this.task.announce(
      remove ? 'The secret could not be removed' : 'The secret could not be saved',
      async () => {
        if (remove) await this.integration.removeSecret(name);
        else
          await this.integration.saveSecret(
            name,
            this.model().secretValue,
            this.model().secretDomains,
            this.secrets().some((secret) => secret.name === name),
          );
        this.model.update((m) => ({ ...m, secretValue: '' }));
        this.output.set(
          remove
            ? 'Secret removed.'
            : `Secret encrypted and saved. Reference it with {{vault:${name}}}.`,
        );
        await this.loadSecrets();
        return remove
          ? named('Secret removed', name)
          : success('Secret saved', 'toast.secretSaved', { v0: `{{vault:${name}}}` });
      },
    );
  }
}

/** The vault tab of the integration panel. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-vault-secrets',
  styleUrl: './integration-panel.scss',
  templateUrl: './vault-secrets.html',
})
export class VaultSecrets {
  readonly vault = input.required<VaultForm>();
}
