import { Injector, computed, inject, signal } from '@angular/core';
import type { ExportSource, TransferEnd, TransferOutcome } from '../../application/mongo-use-cases';
import type { TransferFilesPort } from '../../application/ports';
import { WorkspaceDocument } from '../../domain/models';
import { connectionValue } from '../../domain/mongo';
import { buildQuery } from '../../domain/mongo-query';
import {
  EXTENSIONS,
  MEDIA_TYPES,
  TransferValue,
  emptyTransfer,
  exportName,
  transferValue,
} from '../../domain/mongo-transfer';
import { resolveVariables } from '../../domain/variables';
import type { MongoExplorer } from '../mongo-explorer';
import { named } from '../workspace-state';
import { TransferDraft } from './draft';

/** Files an import may read. */
const IMPORTED = ['json', 'jsonl', 'ndjson', 'csv', 'tsv', 'txt'];

/**
 * The imports and exports of the explorer: the dialog that prepares one, its run with
 * progress and cancellation, and the transfers saved for the connection.
 */
export class MongoTransfers {
  readonly draft = signal<TransferDraft | undefined>(undefined);
  /** The saved transfer open in the dialog, if any. */
  readonly savedId = signal('');
  readonly saved = computed(() =>
    this.explorer.state
      .documents()
      .filter(
        (d) =>
          d.kind === 'mongo-transfer' &&
          transferValue(d.value).connection === this.explorer.connection().id,
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  /** The connections a copy may write to: those that are not read-only. */
  readonly destinations = computed(() =>
    this.explorer.state
      .documents()
      .filter((d) => d.kind === 'connection' && !connectionValue(d.value).readOnly),
  );

  /** The dialog's forms are made outside the explorer's constructor. */
  private readonly injector = inject(Injector);

  constructor(
    private readonly explorer: MongoExplorer,
    private readonly files: TransferFilesPort,
  ) {}

  /** Opens the dialog for the collection chosen; an export reads the query of the bar. */
  open(direction: TransferValue['direction']) {
    const target = this.explorer.target();
    if (!target) return;
    const stored = emptyTransfer(
      direction,
      this.explorer.connection().id,
      target.database,
      target.collection,
    );
    if (direction === 'export') {
      if (!this.explorer.query()) return;
      const { name: _, folder: __, pageSize: ___, ...query } = this.explorer.model();
      stored.query = query;
      stored.scope = Object.values(query).some((text) => text.trim()) ? 'query' : 'collection';
    }
    this.savedId.set('');
    this.draft.set(new TransferDraft(direction, stored, this.injector));
  }
  openSaved(document: WorkspaceDocument) {
    const value = transferValue(document.value);
    this.savedId.set(document.id);
    this.draft.set(new TransferDraft(value.direction, value, this.injector, document.name));
  }
  close() {
    this.draft()?.controller?.abort();
    void this.draft()?.file()?.close();
    this.draft.set(undefined);
  }
  cancel() {
    this.draft()?.controller?.abort();
  }

  /** Chooses the file to import, and previews it. */
  async chooseFile(draft: TransferDraft) {
    draft.error.set('');
    try {
      const file = await this.files.open(IMPORTED);
      if (!file) return;
      await draft.file()?.close();
      draft.file.set(file);
      const preview = await this.explorer.use((cases) => cases.transfer.preview(file));
      draft.preview.set(preview);
      draft.model.update((model) => ({ ...model, format: preview.format }));
      if (preview.format === 'csv') draft.columnsFor(preview.header);
    } catch (error) {
      draft.error.set(this.explorer.state.describe(error));
    }
  }

  /** The fields of the first documents read, for the columns of a CSV export. */
  async loadFields(draft: TransferDraft) {
    try {
      const fields = await this.explorer.use((cases) => cases.transfer.fields(this.source(draft)));
      draft.available.set(fields);
      if (!draft.chosen().length) draft.chosen.set([...fields]);
    } catch (error) {
      draft.error.set(this.explorer.state.describe(error));
    }
  }

  private end(connection: WorkspaceDocument, database: string, collection: string): TransferEnd {
    const { state } = this.explorer;
    return {
      workspace: state.workspaceId(),
      connection,
      scopes: state.scopes(),
      target: { database: database.trim(), collection: collection.trim() },
    };
  }
  private source(draft: TransferDraft): ExportSource {
    const m = draft.model();
    const end = this.end(this.explorer.connection(), m.database, m.collection);
    if (m.scope === 'page')
      return { ...end, query: {}, page: this.explorer.pager.current()?.documents ?? [] };
    if (m.scope === 'collection') return { ...end, query: {} };
    const scopes = this.explorer.state.scopes();
    return { ...end, query: buildQuery(draft.query, (text) => resolveVariables(text, scopes)) };
  }

  /** Why the transfer cannot run yet, as a message key, or `''`. */
  problem(draft: TransferDraft): string {
    const m = draft.model();
    if (!m.database.trim() || !m.collection.trim()) return 'Choose a database and a collection';
    const copy = draft.direction === 'export' && m.destination === 'collection';
    if (draft.direction === 'import' && !draft.file()) return 'Choose a file to import';
    if (copy && (!m.copyDatabase.trim() || !m.copyCollection.trim()))
      return 'Choose the collection to copy to';
    if (
      copy &&
      m.copyConnection === this.explorer.connection().id &&
      m.copyDatabase.trim() === m.database.trim() &&
      m.copyCollection.trim() === m.collection.trim()
    )
      return 'Copy to another collection';
    const writes = draft.direction === 'import' || copy;
    if (writes && m.mode === 'upsert' && !draft.key().length)
      return 'Choose the fields that find the document to replace';
    const written = copy ? m.copyCollection.trim() : m.collection.trim();
    if (writes && m.mode === 'replace' && m.confirm.trim() !== written)
      return 'Type the name of the collection to empty it';
    return '';
  }

  /** Runs the export, copy or import, with its progress, until it ends or is cancelled. */
  async run(draft: TransferDraft) {
    const m = draft.model();
    const problem = this.problem(draft);
    draft.error.set(problem);
    if (problem || draft.phase() === 'running') return;
    const controller = new AbortController();
    draft.controller = controller;
    draft.outcome.set(undefined);
    draft.progress.set({ documents: 0, bytes: 0, total: 0 });
    const counted = (documents: number) => draft.progress.update((p) => ({ ...p, documents }));
    const plan = {
      mode: m.mode,
      key: draft.key(),
      continueOnError: m.continueOnError,
      ...(m.mode === 'replace' ? { clearConfirm: m.confirm.trim() } : {}),
    };
    try {
      let outcome: TransferOutcome | undefined;
      if (draft.direction === 'import') {
        const file = draft.file()!;
        draft.phase.set('running');
        draft.file.set(undefined);
        const destination = this.end(this.explorer.connection(), m.database, m.collection);
        outcome = await this.explorer.use((cases) =>
          cases.transfer.import(
            destination,
            { ...plan, format: m.format, columns: draft.columns() },
            file,
            (progress) => draft.progress.set(progress),
            controller.signal,
          ),
        );
      } else if (m.destination === 'collection') {
        const connection = this.destinations().find((d) => d.id === m.copyConnection);
        if (!connection) return draft.error.set('Choose the collection to copy to');
        draft.phase.set('running');
        const destination = this.end(connection, m.copyDatabase, m.copyCollection);
        outcome = await this.explorer.use((cases) =>
          cases.transfer.copy(this.source(draft), destination, plan, counted, controller.signal),
        );
      } else {
        if (m.format === 'csv' && !draft.chosen().length) await this.loadFields(draft);
        if (m.format === 'csv' && !draft.chosen().length)
          return draft.error.set(draft.error() || 'Choose the fields of the CSV');
        const name = exportName(m.collection, m.format);
        const file = await this.files.save(name, EXTENSIONS[m.format], MEDIA_TYPES[m.format]);
        if (!file) return;
        draft.phase.set('running');
        const format = { format: m.format, flavour: m.flavour, fields: draft.chosen() };
        outcome = await this.explorer.use((cases) =>
          cases.transfer.export(this.source(draft), format, file, counted, controller.signal),
        );
      }
      draft.outcome.set(outcome);
      draft.phase.set('done');
      if (outcome.inserted + outcome.upserted + outcome.replaced + outcome.cleared) this.refresh();
    } catch (error) {
      draft.error.set(this.explorer.state.describe(error));
      draft.phase.set('setup');
    } finally {
      draft.controller = undefined;
    }
  }
  /** The collection shown may have changed: its page and statistics load again. */
  private refresh() {
    void this.explorer.pager.find(this.explorer.pager.current()?.offset);
    void this.explorer.browser.loadStats();
  }
  /** Back to the settings, to run the transfer again. */
  again(draft: TransferDraft) {
    draft.outcome.set(undefined);
    draft.phase.set('setup');
    draft.model.update((model) => ({ ...model, confirm: '' }));
  }

  async save(draft: TransferDraft) {
    const { explorer } = this;
    await explorer.state.announce('The transfer could not be saved', async () => {
      const existing = explorer.state.documents().find((d) => d.id === this.savedId());
      const saved = await explorer.use((cases) =>
        cases.transfer.save(
          explorer.state.workspaceId(),
          draft.model().name,
          draft.value(explorer.connection().id),
          existing,
        ),
      );
      explorer.state.applySaved([saved]);
      this.savedId.set(saved.id);
      draft.model.update((model) => ({ ...model, name: saved.name }));
      return named('Transfer saved', saved.name);
    });
  }
  async remove(document: WorkspaceDocument) {
    const { explorer } = this;
    if (!explorer.state.confirm('Delete this saved transfer?')) return;
    await explorer.state.announce('The transfer could not be deleted', async () => {
      await explorer.use((cases) => cases.transfer.remove(document));
      explorer.state.forget(document);
      if (this.savedId() === document.id) this.savedId.set('');
      return named('Transfer deleted', document.name);
    });
  }
}
