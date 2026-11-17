import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { EXPORT_FORMATS } from '../../domain/db/transfer/export';
import type { TransferDraft } from '../db-panel/transfer-draft';

/** The format of an export and its options, as DBeaver's «Data export». */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-transfer-export',
  template: `
    @let fields = draft().fields;
    @let model = draft().model();
    <div class="db-transfer-grid">
      <label class="field"
        >{{ 'Format' | transloco }}
        <select [formField]="fields.format">
          @for (format of formats; track format) {
            <option [value]="format">{{ 'db.transfer.format.' + format | transloco }}</option>
          }
        </select>
      </label>
      @if (model.format === 'csv') {
        <label class="field"
          >{{ 'Separator' | transloco }}
          <select [formField]="fields.separator">
            <option value=",">,</option>
            <option value=";">;</option>
            <option [value]="tab">{{ 'Tab' | transloco }}</option>
            <option value="|">|</option>
          </select>
        </label>
        <label class="check-field"
          ><input type="checkbox" [formField]="fields.header" />{{
            'A first line with the column names' | transloco
          }}</label
        >
      }
      @if (
        model.format === 'csv' ||
        model.format === 'markdown' ||
        model.format === 'html' ||
        model.format === 'xml' ||
        model.format === 'text'
      ) {
        <label class="field"
          >{{ 'NULL is written as' | transloco }}<input [formField]="fields.nullText"
        /></label>
      }
      @if (model.format === 'sql') {
        <label class="field"
          >{{ 'Rows in each INSERT' | transloco }}
          <input type="number" [formField]="fields.rowsPerInsert"
        /></label>
        <label class="field"
          >{{ 'Written for' | transloco }}
          <select [formField]="fields.dialect">
            <option value="">{{ 'The same engine' | transloco }}</option>
            <option value="postgresql">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="tsql">SQL Server</option>
            <option value="sqlite">SQLite</option>
          </select>
        </label>
        <label class="check-field"
          ><input type="checkbox" [formField]="fields.createTable" />{{
            'Begin with its CREATE TABLE' | transloco
          }}</label
        >
      }
      <label class="field"
        >{{ 'Binary values' | transloco }}
        <select [formField]="fields.binary">
          <option value="base64">Base64</option>
          <option value="hex">{{ 'Hexadecimal' | transloco }}</option>
          <option value="null">NULL</option>
        </select>
      </label>
      <label class="check-field"
        ><input type="checkbox" [formField]="fields.bom" />{{
          'A byte order mark first (for spreadsheets)' | transloco
        }}</label
      >
    </div>
    <p class="muted">{{ 'db.transfer.exportFile' | transloco: { v0: fileName() } }}</p>
  `,
  styleUrl: './transfer.scss',
})
export class DbTransferExport {
  readonly draft = input.required<TransferDraft>();
  protected readonly formats = EXPORT_FORMATS;
  protected readonly tab = '\t';

  protected fileName() {
    const { name, extension } = this.draft().exportName();
    return `${name}.${extension}`;
  }
}
