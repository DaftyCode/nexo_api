import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, model, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { VariableRow, emptyVariable } from '../domain/variables';

/** Edits variable rows; values marked as secret are masked until revealed. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-variable-editor',
  styleUrl: './variable-editor.scss',
  templateUrl: './variable-editor.html',
})
export class VariableEditor {
  readonly rows = model<VariableRow[]>([emptyVariable()]);
  readonly readonly = input(false);
  protected readonly fields = form(this.rows);
  protected readonly revealed = signal<number[]>([]);
  protected add() {
    this.rows.update((rows) => [...rows, emptyVariable()]);
  }
  protected remove(index: number) {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.revealed.set([]);
  }
  protected toggleReveal(index: number) {
    this.revealed.update((list) =>
      list.includes(index) ? list.filter((i) => i !== index) : [...list, index],
    );
  }
  protected masked(index: number) {
    return !!this.rows()[index]?.secret && !this.revealed().includes(index);
  }
}
