import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, applyEach, form, max, min } from '@angular/forms/signals';
import {
  MASKING_SAMPLE,
  MASK_METHODS,
  MAX_KEEP,
  MaskingSet,
  emptyMaskingForm,
  emptyRule,
  maskingForm,
  maskingProblem,
} from '../domain/masking';
import { PanelTask } from './panel-task';
import { WorkspaceState, success } from './workspace-state';

/**
 * Settings → Masking: sets of rules that hide or replace sensitive fields when a run, a
 * response or a database is exported, and that MCP agents read through when marked. A set
 * can be tried on an example before it is saved.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-masking-sets',
  templateUrl: './masking-sets.html',
})
export class MaskingSets {
  protected readonly state = inject(WorkspaceState);
  protected readonly task = new PanelTask(this.state);
  protected readonly methods = MASK_METHODS;
  protected readonly sets = computed(() => this.state.cases.masking.sets(this.state.documents()));
  /** The set in the form: its id, `new`, or none when the form is closed. */
  protected readonly editing = signal<string | undefined>(undefined);
  protected readonly model = signal(emptyMaskingForm());
  protected readonly fields = form(this.model, (p) => {
    applyEach(p.rules, (rule) => {
      min(rule.keep, 0);
      max(rule.keep, MAX_KEEP);
    });
  });
  protected readonly problem = computed(() => maskingProblem(this.model()));
  /** The example the rules are tried on. */
  protected readonly trial = signal({ sample: MASKING_SAMPLE });
  protected readonly trialFields = form(this.trial);
  /** What the rules in the form made of the example. */
  protected readonly tried = signal('');
  private readonly existing = computed(() =>
    this.state.documents().find((document) => document.id === this.editing()),
  );

  protected create() {
    this.model.set(emptyMaskingForm());
    this.tried.set('');
    this.editing.set('new');
  }
  protected edit(set: MaskingSet) {
    this.model.set(maskingForm(set));
    this.tried.set('');
    this.editing.set(set.id);
  }
  protected cancel() {
    this.editing.set(undefined);
  }
  protected addRule() {
    this.model.update((model) => ({ ...model, rules: [...model.rules, emptyRule()] }));
  }
  protected removeRule(index: number) {
    this.model.update((model) => ({
      ...model,
      rules: model.rules.filter((_, at) => at !== index),
    }));
  }
  protected try() {
    void this.task.run(async () => {
      this.tried.set('');
      const masked = await this.state.cases.masking.tryRules(
        this.state.workspaceId(),
        this.model().rules,
        this.trial().sample,
      );
      this.tried.set(JSON.stringify(masked, null, 2));
    });
  }
  protected save() {
    const editing = this.editing();
    if (!editing || this.problem()) return;
    void this.task.announce('The masking set could not be saved', async () => {
      const id = editing === 'new' ? crypto.randomUUID() : editing;
      const saved = await this.state.cases.masking.save(
        this.state.workspaceId(),
        id,
        this.model(),
        this.existing(),
      );
      this.state.applySaved([saved]);
      this.editing.set(undefined);
      return success('Masking set saved', 'toast.maskingSaved', { v0: saved.name });
    });
  }
  protected remove(set: MaskingSet) {
    const document = this.state.documents().find((d) => d.id === set.id);
    if (!document || !this.state.confirm('Delete this masking set?')) return;
    void this.task.announce('The masking set could not be deleted', async () => {
      await this.state.cases.masking.remove(document);
      this.state.forget(document);
      return success('Masking set deleted', 'toast.maskingDeleted', { v0: set.name });
    });
  }
}
