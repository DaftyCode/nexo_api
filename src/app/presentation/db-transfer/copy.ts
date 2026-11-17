import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import type { TransferDraft } from '../db-panel/transfer-draft';

/**
 * Where a copy goes: another connection (of the same engine or another), its table, and
 * the `CREATE TABLE` written for its engine, with the columns that become text said.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transfer-copy',
  template: `
    @let d = draft();
    @let fields = d.fields;
    <div class="db-transfer-grid">
      <label class="field"
        >{{ 'Target connection' | transloco }}
        <select [formField]="fields.target" (change)="prepare()">
          <option value="">{{ 'Choose one' | transloco }}</option>
          @for (connection of d.targets(); track connection.id) {
            <option [value]="connection.id">{{ connection.name }}</option>
          }
        </select>
      </label>
      <label class="field"
        >{{ 'Target table' | transloco
        }}<input [formField]="fields.table" autocomplete="off" (change)="prepare()"
      /></label>
      <label class="check-field"
        ><input type="checkbox" [formField]="fields.create" />{{
          'Create the table' | transloco
        }}</label
      >
    </div>
    @if (preparing()) {
      <div class="spinner small" role="status" [attr.aria-label]="'Loading' | transloco"></div>
    }
    @if (d.model().create && d.ddl(); as ddl) {
      <pre class="db-transfer-ddl" [attr.aria-label]="'The table it creates' | transloco">{{
        ddl.sql
      }}</pre>
      @if (ddl.text.length) {
        <p class="db-transfer-note">
          {{ 'db.transfer.asText' | transloco: { v0: ddl.text.join(', ') } }}
        </p>
      }
    }
  `,
  styleUrl: './transfer.scss',
})
export class DbTransferCopy {
  readonly draft = input.required<TransferDraft>();
  protected readonly preparing = signal(false);

  protected prepare() {
    queueMicrotask(async () => {
      this.preparing.set(true);
      try {
        await this.draft().run.prepareCopy();
      } catch (error) {
        this.draft().error.set(this.draft().section.state.describe(error));
      } finally {
        this.preparing.set(false);
      }
    });
  }
}
