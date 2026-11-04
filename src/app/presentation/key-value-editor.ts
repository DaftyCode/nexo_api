import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { KeyValue, row } from '../domain/models';

@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-key-value-editor',
  styleUrl: './key-value-editor.scss',
  templateUrl: './key-value-editor.html',
})
export class KeyValueEditor {
  readonly rows = model<KeyValue[]>([row()]);
  protected readonly fields = form(this.rows);
  protected add() {
    this.rows.update((rows) => [...rows, row()]);
  }
  protected remove(index: number) {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
  }
}
