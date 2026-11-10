import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { INTEGRATION } from '../composition/providers';
import { RevisionEntry } from '../application/ports';
import {
  ApiDiff,
  ApiInspection,
  definitionSource,
  findingCounts,
  messageParams,
  searchOutline,
} from '../domain/api-definitions';
import { PanelTask } from './panel-task';
import { WorkspaceState } from './workspace-state';
import { CodeEditor, CodeMark } from './code-editor';
import { TranslocoService } from '@jsverse/transloco';

const starter = 'openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}\n';

/** Where a definition to compare comes from. */
type Version = 'editing' | 'saved' | `r:${number}`;

/**
 * API definitions: edit an OpenAPI or Swagger document of the workspace, see its problems,
 * explore its paths and schemas, and compare two versions of it with the changes that break
 * clients marked. Findings and changes jump to their line in the editor.
 */
@Component({
  imports: [TranslocoPipe, FormField, DatePipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-api-definitions',
  styleUrl: './api-definitions.scss',
  templateUrl: './api-definitions.html',
})
export class ApiDefinitions {
  protected readonly state = inject(WorkspaceState);
  private readonly integration = inject(INTEGRATION);
  protected readonly task = new PanelTask(this.state);
  private readonly editor = viewChild<CodeEditor>('editor');
  private readonly translator = inject(TranslocoService);
  /** JSON when the definition is written as JSON, YAML otherwise. */
  protected readonly sourceLanguage = computed(() =>
    /^\s*[{[]/.test(this.model().source) ? 'json' : 'yaml',
  );
  /** The findings on their lines, while they still describe what is in the editor. */
  protected readonly marks = computed<CodeMark[]>(() => {
    const inspection = this.inspection();
    if (!inspection || this.stale()) return [];
    return inspection.findings
      .filter((finding) => finding.line)
      .map((finding) => ({
        line: finding.line!,
        severity: finding.severity,
        message: this.translator.translate(`lint.${finding.rule}`, messageParams(finding.params)),
      }));
  });
  protected readonly messageParams = messageParams;

  protected readonly definitions = computed(() =>
    this.state.documents().filter((document) => document.kind === 'api'),
  );
  /** The definition being edited; empty for a new one. */
  protected readonly selected = signal('');
  protected readonly document = computed(() =>
    this.definitions().find((document) => document.id === this.selected()),
  );
  protected readonly model = signal({ name: 'My API', source: starter });
  protected readonly fields = form(this.model);
  protected readonly tab = signal<'problems' | 'explorer' | 'changes'>('problems');

  protected readonly inspection = signal<ApiInspection | undefined>(undefined);
  /** The text the inspection is about, to tell when it is out of date. */
  private readonly inspected = signal('');
  protected readonly stale = computed(
    () => !!this.inspection() && this.inspected() !== this.model().source,
  );
  protected readonly counts = computed(() => findingCounts(this.inspection()?.findings ?? []));
  protected readonly query = signal('');
  protected readonly paths = computed(() =>
    searchOutline(this.inspection()?.outline?.paths ?? [], this.query()),
  );
  protected readonly schemas = computed(() => {
    const needle = this.query().trim().toLowerCase();
    return (this.inspection()?.outline?.schemas ?? []).filter((schema) =>
      schema.name.toLowerCase().includes(needle),
    );
  });

  protected readonly revisions = signal<RevisionEntry[]>([]);
  protected readonly base = signal<Version>('saved');
  protected readonly target = signal<Version>('editing');
  protected readonly diff = signal<ApiDiff | undefined>(undefined);
  /** Whether the lines of the comparison's later version are the editor's. */
  protected readonly diffInEditor = signal(false);

  constructor() {
    // The revisions of the definition chosen, to compare them.
    effect(() => {
      const document = this.document();
      untracked(() => {
        this.revisions.set([]);
        if (document) void this.loadRevisions(document.id);
      });
    });
  }

  private async loadRevisions(id: string) {
    try {
      const revisions = await this.integration.revisions(id);
      if (this.selected() === id) this.revisions.set(revisions);
    } catch {
      // Without its history, a definition still compares with what is being edited.
    }
  }

  protected select(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    this.selected.set(id);
    const document = this.document();
    this.fields().reset({
      name: document?.name ?? 'My API',
      source: document ? definitionSource(document) : starter,
    });
    this.inspection.set(undefined);
    this.diff.set(undefined);
    this.base.set('saved');
    this.target.set('editing');
  }

  /** Saves the definition: a new document, or a new revision of the one chosen. */
  protected save() {
    void this.task.run(async () => {
      const { name, source } = this.model();
      if (!name.trim()) throw new Error('A name is required');
      const document = this.document();
      if (document) {
        await this.state.cases.saveDocument({
          ...document,
          name: name.trim(),
          value: { ...(document.value as object), source },
        });
      } else {
        const created = await this.state.cases.createDocument(
          this.state.workspaceId(),
          'api',
          name,
          { source },
        );
        this.selected.set(created.id);
      }
      await this.state.refresh();
      const saved = this.document();
      if (saved) void this.loadRevisions(saved.id);
      this.state.notice.set('Definition saved');
      await this.inspect();
    });
  }
  protected check() {
    void this.task.run(() => this.inspect());
  }
  private async inspect() {
    const source = this.model().source;
    this.inspection.set(await this.integration.inspectApi(this.state.workspaceId(), source));
    this.inspected.set(source);
  }
  protected generate() {
    void this.state.importContent(this.model().source);
  }

  /** The text of a version of the definition. */
  private sourceOf(version: Version) {
    if (version === 'editing') return this.model().source;
    if (version === 'saved') return definitionSource(this.document());
    const revision = Number(version.slice(2));
    const entry = this.revisions().find((r) => r.revision === revision);
    if (!entry) throw new Error('Choose a version to compare');
    return definitionSource(entry.value);
  }
  protected setBase(event: Event) {
    this.base.set((event.target as HTMLSelectElement).value as Version);
  }
  protected setTarget(event: Event) {
    this.target.set((event.target as HTMLSelectElement).value as Version);
  }
  protected compare() {
    void this.task.run(async () => {
      if (!this.document() && (this.base() !== 'editing' || this.target() !== 'editing'))
        throw new Error('Save the definition first, to compare it with its earlier versions');
      const diff = await this.integration.diffApi(
        this.state.workspaceId(),
        this.sourceOf(this.base()),
        this.sourceOf(this.target()),
      );
      this.diff.set(diff);
      this.diffInEditor.set(this.target() === 'editing');
    });
  }

  protected setQuery(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** Selects a line of the editor and scrolls to it. */
  protected goTo(line: number | null | undefined) {
    if (line) this.editor()?.selectLine(line);
  }
}
