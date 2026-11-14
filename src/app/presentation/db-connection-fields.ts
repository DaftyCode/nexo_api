import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { CONNECTION_TYPES, TLS_MODES } from '../domain/db/connection';
import { EngineProfile } from '../domain/db/engines';
import { DbForm } from '../domain/db/form';
import { CONNECTION_COLORS } from '../domain/mongo';
import type { EditorPage } from './db-connection-editor';

/** A tab of the connection form: main, TLS, driver settings or general. */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-connection-fields',
  templateUrl: './db-connection-fields.html',
  styleUrl: './db-connection-editor.scss',
})
export class DbConnectionFields {
  readonly page = input.required<EditorPage>();
  readonly fields = input.required<FieldTree<DbForm>>();
  readonly profile = input.required<EngineProfile>();
  /** Whether the vault holds the saved password or client key, kept when left blank. */
  readonly passwordStored = input(false);
  readonly keyStored = input(false);
  readonly folders = input<readonly string[]>([]);
  protected readonly types = CONNECTION_TYPES;
  protected readonly tlsModes = TLS_MODES;
  protected readonly colors = CONNECTION_COLORS;
  protected readonly settings = computed(() => this.fields()().value());
  /** The settings of the driver not chosen yet. */
  protected readonly unused = computed(() => {
    const chosen = new Set(this.settings().params.map((row) => row.name));
    return this.profile().properties.filter((property) => !chosen.has(property.name));
  });

  protected describe(name: string) {
    return this.profile().properties.find((property) => property.name === name)?.description;
  }
  protected addParam() {
    const name = this.unused()[0]?.name ?? '';
    this.fields()().value.update((form) => ({
      ...form,
      params: [...form.params, { name, value: '' }],
    }));
  }
  protected removeParam(index: number) {
    this.fields()().value.update((form) => ({
      ...form,
      params: form.params.filter((_, at) => at !== index),
    }));
  }
  protected setColor(color: string) {
    this.fields()().value.update((form) => ({ ...form, color }));
  }
  protected tlsLabel(mode: string) {
    return `db.tls.${mode}`;
  }
  protected typeLabel(type: string) {
    return `db.type.${type}`;
  }
}
