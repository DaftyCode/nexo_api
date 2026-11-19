import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { form } from '@angular/forms/signals';
import { TranslocoService } from '@jsverse/transloco';
import { ExecutionResponse, Run } from '../../domain/models';
import {
  CompareSideForm,
  ResponseComparison,
  ResponseSource,
  ignoreList,
  runResults,
  sideForm,
  sourceOf,
} from '../../domain/response-compare';
import { WorkspaceState } from '../workspace-state';
import { sendToCompare } from './sending';

/** What the comparison form edits: both responses and what is left out. */
export interface CompareModel {
  source: CompareSideForm;
  target: CompareSideForm;
  /** Body paths, separated by commas or lines. */
  ignore: string;
  /** Header names, separated by commas or lines. */
  ignoreHeaders: string;
}

/** A comparison made: what changed, and the names of both responses. */
export interface Compared {
  result: ResponseComparison;
  sourceLabel: string;
  targetLabel: string;
}

/**
 * Comparing two responses of the open workspace: where each one comes from, reading them
 * (or sending the request of the tab with an environment), and what the backend says
 * changed. Changing what is left out compares the same responses again, without sending.
 */
@Injectable({ providedIn: 'root' })
export class CompareStore {
  private readonly state = inject(WorkspaceState);
  private readonly i18n = inject(TranslocoService);
  readonly model = signal<CompareModel>({
    source: sideForm(),
    target: sideForm(),
    ignore: '',
    ignoreHeaders: '',
  });
  readonly fields = form(this.model);
  readonly compared = signal<Compared | undefined>(undefined);
  readonly running = signal(false);
  readonly error = signal('');
  /** The collection runs read, by id, to choose one of their responses. */
  readonly runs = signal<Readonly<Record<string, Run>>>({});
  /** Runs kept in the workspace, newest first. */
  readonly savedRuns = computed(() =>
    this.state
      .documents()
      .filter((d) => d.kind === 'run')
      .sort((a, b) => b.updated_at - a.updated_at),
  );
  /** History entries, newest first. */
  readonly history = computed(() =>
    [...this.state.history()].sort((a, b) => b.updated_at - a.updated_at),
  );
  /** Tabs with a response. */
  readonly tabs = computed(() =>
    this.state.tabs().filter((tab) => this.state.tabsStore.responseOf(tab.id)),
  );
  /** The responses compared last, compared again when what is left out changes. */
  private responses: [ExecutionResponse, ExecutionResponse] | undefined;
  /** What was left out of the comparison shown. */
  private comparedWith = '';
  private workspace = '';

  constructor() {
    effect(() => {
      const workspace = this.state.workspaceId();
      untracked(() => {
        if (workspace !== this.workspace) this.reset();
        this.workspace = workspace;
      });
    });
    // The responses of a run are listed once it is chosen.
    effect(() => {
      const { source, target } = this.model();
      untracked(() => {
        for (const side of [source, target])
          if (side.kind === 'run' && side.run) void this.loadRun(side.run).catch(() => undefined);
      });
    });
  }

  /** The responses of a run chosen, in the order they were sent. */
  results(run: string) {
    return runResults(this.runs()[run]);
  }

  /** Shows the comparison with these responses; a side not given keeps its choice. */
  open(source?: ResponseSource, target?: ResponseSource) {
    this.model.update((model) => ({
      ...model,
      source: source ? sideForm(source) : model.source,
      target: target ? sideForm(target) : model.target,
    }));
    this.compared.set(undefined);
    this.responses = undefined;
    this.error.set('');
    this.state.section.set('compare');
  }

  /**
   * Compares the response of a tab with the one before it of the same request, if the
   * history keeps it, or else with sending the request again.
   */
  openTab(tab: string) {
    const request = this.state.tabs().find((each) => each.id === tab)?.request;
    const name = request ? `${request.method} ${request.url}` : '';
    // The newest entry is the response the tab shows, when it was just sent.
    const earlier = this.history().filter((entry) => entry.name === name)[1];
    this.open(
      earlier
        ? { kind: 'history', id: earlier.id }
        : { kind: 'send', environment: this.state.environmentId() },
      { kind: 'tab', tab },
    );
  }
  /** Compares the last two responses of the history, the older one first. */
  openHistory() {
    const [newer, older] = this.history();
    this.open(
      older ? { kind: 'history', id: older.id } : undefined,
      newer ? { kind: 'history', id: newer.id } : undefined,
    );
  }
  /** Compares the first two responses of the last collection run. */
  openRun() {
    const run = this.savedRuns()[0];
    if (!run) return this.open();
    this.open({ kind: 'run', id: run.id, index: 0 }, { kind: 'run', id: run.id, index: 1 });
  }

  /** The first response becomes the second, and the other way round. */
  swap() {
    this.model.update((model) => ({ ...model, source: model.target, target: model.source }));
    const compared = this.compared();
    if (compared && this.responses) {
      this.responses = [this.responses[1], this.responses[0]];
      void this.again(true);
    }
  }

  /** Reads both responses (sending the request of the tab if asked) and compares them. */
  async compare() {
    if (this.running()) return;
    await this.task(async () => {
      const { source, target } = this.model();
      const first = await this.read(sourceOf(source));
      const second = first && (await this.read(sourceOf(target)));
      if (!first || !second) return;
      this.responses = [first, second];
      await this.difference();
    });
  }

  /**
   * Compares the responses read last again, with what is left out now; nothing when that
   * did not change, unless `always`.
   */
  async again(always = false) {
    if (!this.responses || this.running()) return;
    if (!always && this.leftOut() === this.comparedWith) return;
    await this.task(() => this.difference());
  }

  /** Runs a comparison; what was left out while it ran is compared right after. */
  private async task(work: () => Promise<void>) {
    this.running.set(true);
    this.error.set('');
    let done = false;
    try {
      await work();
      done = true;
    } catch (error) {
      this.error.set(this.state.describe(error));
    } finally {
      this.running.set(false);
    }
    if (done) await this.again();
  }

  private async difference() {
    const [first, second] = this.responses!;
    const model = this.model();
    const result = await this.state.cases.compare.compare(
      this.state.workspaceId(),
      first,
      second,
      ignoreList(model.ignore),
      ignoreList(model.ignoreHeaders),
    );
    this.compared.set({
      result,
      sourceLabel: this.label(model.source),
      targetLabel: this.label(model.target),
    });
    this.comparedWith = this.leftOut(model);
  }
  /** What is left out, as typed. */
  private leftOut(model = this.model()) {
    return JSON.stringify([model.ignore, model.ignoreHeaders]);
  }

  private reset() {
    this.compared.set(undefined);
    this.responses = undefined;
    this.runs.set({});
    this.error.set('');
    this.model.update((model) => ({ ...model, source: sideForm(), target: sideForm() }));
  }

  private async loadRun(id: string): Promise<Run> {
    const known = this.runs()[id];
    if (known) return known;
    const document = this.savedRuns().find((d) => d.id === id);
    if (!document) throw new Error('Choose a collection run');
    const run = await this.state.cases.compare.run(document);
    this.runs.update((runs) => ({ ...runs, [id]: run }));
    return run;
  }

  /** A response chosen; nothing when sending it was not confirmed. */
  private async read(source: ResponseSource): Promise<ExecutionResponse | undefined> {
    switch (source.kind) {
      case 'tab': {
        const response = this.state.tabsStore.responseOf(source.tab);
        if (!response) throw new Error('Choose a tab with a response');
        return response;
      }
      case 'history': {
        const document = this.state.history().find((d) => d.id === source.id);
        if (!document) throw new Error('Choose a response of the history');
        return this.state.cases.compare.historyResponse(document);
      }
      case 'run': {
        const response = (await this.loadRun(source.id)).results[source.index];
        if (!response) throw new Error('Choose a response of the run');
        return response;
      }
      case 'send':
        return sendToCompare(this.state, source.environment);
    }
  }

  /** When something was kept (seconds since 1970), in the language of the interface. */
  private when(seconds: number) {
    return new Date(seconds * 1000).toLocaleString(this.i18n.getActiveLang());
  }
  /** The name of a response chosen, as both sides are headed. */
  private label(side: CompareSideForm): string {
    const t = (key: string, params?: Record<string, unknown>) =>
      this.i18n.translate<string>(key, params);
    switch (side.kind) {
      case 'tab': {
        const request = this.state.tabs().find((tab) => tab.id === side.tab)?.request;
        return request?.name || `${request?.method ?? ''} ${request?.url ?? ''}`.trim();
      }
      case 'history': {
        const entry = this.state.history().find((d) => d.id === side.history);
        return entry ? `${entry.name} · ${this.when(entry.updated_at)}` : '';
      }
      case 'run': {
        const result = this.results(side.run)[Number(side.result)];
        const run = this.savedRuns().find((d) => d.id === side.run);
        if (!result || !run) return '';
        const name = t('compare.runResult', { v0: result.name, v1: result.iteration });
        return `${name} · ${this.when(run.updated_at)}`;
      }
      case 'send': {
        const request = this.state.active()?.request;
        const environment = this.state.environments().find((d) => d.id === side.environment);
        return t('compare.sent', {
          v0: request?.name || request?.url || '',
          v1: environment?.name ?? t('No environment'),
        });
      }
    }
  }
}
