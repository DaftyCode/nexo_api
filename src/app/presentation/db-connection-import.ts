import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import type { ImportOutcome } from '../application/database-use-cases';
import { ConnectionImport } from '../domain/db/import';
import { DbSection } from './db-panel/section';
import { PanelTask } from './panel-task';
import { success } from './workspace-state';

/** The tools a file comes from, as they are written; a list of URLs is said in words. */
const SOURCES: Record<ConnectionImport['source'], string> = {
  dbeaver: 'DBeaver',
  pgadmin: 'pgAdmin',
  workbench: 'MySQL Workbench',
  urls: '',
  nexo: 'Nexo',
};

/**
 * «Import connections» (DB-25): a file of DBeaver, pgAdmin or MySQL Workbench, Nexo's own, or
 * a list of URLs pasted. What it brings is shown before anything is saved: the connections,
 * those that cannot come and why, and what each one still needs (no password comes).
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-connection-import',
  templateUrl: './db-connection-import.html',
  styleUrl: './db-connection-import.scss',
})
export class DbConnectionImport {
  readonly closed = output<void>();
  protected readonly section = inject(DbSection);
  protected readonly task = new PanelTask(this.section.state);
  protected readonly model = signal({ text: '' });
  protected readonly fields = form(this.model);
  /** What the file or the text brings, once read. */
  protected readonly read = signal<ConnectionImport | undefined>(undefined);
  protected readonly problem = signal('');
  protected readonly outcome = signal<ImportOutcome | undefined>(undefined);
  protected readonly connections = computed(
    () => this.read()?.documents.filter((document) => document.kind === 'connection') ?? [],
  );
  protected readonly source = computed(() => {
    const read = this.read();
    return read ? SOURCES[read.source] : '';
  });

  protected file(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.task.run(async () => {
      await this.readText(await this.section.state.cases.files.read(file));
      input.value = '';
    });
  }
  protected paste() {
    void this.task.run(() => this.readText(this.model().text));
  }
  private async readText(text: string) {
    this.outcome.set(undefined);
    try {
      this.read.set((await this.section.cases()).imports.read(text));
      this.problem.set('');
    } catch (error) {
      this.read.set(undefined);
      this.problem.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected save() {
    const read = this.read();
    if (!read || !this.connections().length) return;
    void this.task.announce('The connections could not be imported', async () => {
      const state = this.section.state;
      const outcome = await (await this.section.cases()).imports.save(state.workspaceId(), read);
      state.applySaved(outcome.saved);
      this.outcome.set(outcome);
      this.read.set(undefined);
      const count = outcome.saved.filter((document) => document.kind === 'connection').length;
      if (!outcome.refused.length) this.closed.emit();
      return success('Import completed', 'db.import.done', { v0: String(count) });
    });
  }
}
