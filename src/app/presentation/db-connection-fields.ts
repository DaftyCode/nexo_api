import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { DATABASE_FILES, NATIVE_FILES } from '../composition/providers';
import { TLS_MODES } from '../domain/db/connection';
import { BUILTIN_TYPES, ConnectionTypeChoice } from '../domain/db/connection-types';
import { EngineProfile } from '../domain/db/engines';
import { DbForm } from '../domain/db/form';
import { hasNativeTools } from '../domain/db/native';
import { CONNECTION_COLORS } from '../domain/mongo';
import type { EditorPage } from './db-connection-editor/pages';

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
  /** The types a connection may have: built in, and the person's own (DB-25). */
  readonly types = input<readonly ConnectionTypeChoice[]>(BUILTIN_TYPES);
  protected readonly tlsModes = TLS_MODES;
  protected readonly colors = CONNECTION_COLORS;
  /** The desktop dialog that chooses the file of a SQLite connection. */
  protected readonly files = inject(DATABASE_FILES);
  /** The desktop dialog that chooses the folder of the client tools. */
  protected readonly native = inject(NATIVE_FILES);
  protected readonly tools = computed(() => hasNativeTools(this.settings().driver));
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
  /** The file chosen in the dialog; a new one is made when the connection opens. */
  protected async chooseFile(create: boolean) {
    const path = await this.files.choose(create);
    if (!path) return;
    this.fields()().value.update((form) => {
      const params = form.params.filter((row) => row.name !== 'create');
      return {
        ...form,
        database: path,
        params: create ? [...params, { name: 'create', value: 'true' }] : form.params,
      };
    });
  }
  /** The folder of the client tools, chosen in the dialog. */
  protected async chooseClient() {
    const folder = await this.native.choose('folder');
    if (folder) this.fields()().value.update((form) => ({ ...form, localClient: folder }));
  }
  protected setColor(color: string) {
    this.fields()().value.update((form) => ({ ...form, color }));
  }
  protected tlsLabel(mode: string) {
    return `db.tls.${mode}`;
  }
  protected typeLabel(type: ConnectionTypeChoice) {
    return type.builtin ? `db.type.${type.id}` : type.name;
  }
}
