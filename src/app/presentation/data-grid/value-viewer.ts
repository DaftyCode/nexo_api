import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import {
  GridFormats,
  base64Bytes,
  classOf,
  dateForms,
  hexDump,
  imageType,
  prettyJson,
  prettyXml,
  truncation,
} from '../../domain/db/grid/cells';
import { ResultColumn, cellText } from '../../domain/db/results';
import { CodeEditor } from '../code-editor';
import { WorkspaceState } from '../workspace-state';

/**
 * The «Value» panel: the active cell's whole value with a viewer for its class (JSON and XML
 * laid out and folded, binaries in hexadecimal or as the image they are, dates in several
 * forms), whether the driver cut it, and saving it to a file.
 */
@Component({
  imports: [TranslocoPipe, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-value-viewer',
  template: `
    <p class="viewer-head">
      <strong>{{ column().name }}</strong>
      <span class="muted">{{ column().typeName }}</span>
      <button type="button" class="button small subtle" (click)="save()">
        {{ 'Save to a file' | transloco }}
      </button>
    </p>
    @if (cut().truncated) {
      <p class="viewer-cut" role="note">
        {{ 'db.value.truncated' | transloco: { v0: cut().size ?? '?' } }}
      </p>
    }
    @switch (shape()) {
      @case ('null') {
        <p class="muted">NULL</p>
      }
      @case ('json') {
        <app-code-editor
          language="json"
          size="large"
          [value]="pretty()"
          [readonly]="true"
          [label]="column().name"
        />
      }
      @case ('xml') {
        <app-code-editor
          language="xml"
          size="large"
          [value]="pretty()"
          [readonly]="true"
          [label]="column().name"
        />
      }
      @case ('binary') {
        @if (image(); as source) {
          <img class="viewer-image" [src]="source" [attr.alt]="column().name" />
        }
        <pre class="viewer-text" tabindex="0">{{ hex() }}</pre>
      }
      @case ('date') {
        <dl class="viewer-dates">
          @for (form of dates(); track form.label) {
            <dt>{{ form.label | transloco }}</dt>
            <dd>{{ form.text }}</dd>
          }
        </dl>
      }
      @default {
        <pre class="viewer-text" tabindex="0">{{ text() }}</pre>
      }
    }
  `,
  styles: `
    .viewer-head {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-3);
      margin: 0 0 var(--nexo-space-3);
    }
    .viewer-cut {
      color: var(--nexo-color-warning);
    }
    .viewer-text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--nexo-font-mono);
    }
    .viewer-image {
      max-width: 100%;
      margin-bottom: var(--nexo-space-3);
    }
    .viewer-dates {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--nexo-space-1) var(--nexo-space-6);
    }
    .viewer-dates dd {
      margin: 0;
    }
  `,
})
export class ValueViewer {
  readonly value = input.required<unknown>();
  readonly column = input.required<ResultColumn>();
  readonly formats = input.required<GridFormats>();
  private readonly state = inject(WorkspaceState);
  protected readonly cut = computed(() => truncation(this.value()));
  protected readonly text = computed(() => cellText(this.value()));
  protected readonly shape = computed(() => {
    const kind = classOf(this.value());
    if ((this.value() as { $t?: unknown })?.$t === 'xml') return 'xml';
    return kind === 'number' || kind === 'boolean' ? 'text' : kind;
  });
  protected readonly pretty = computed(() =>
    this.shape() === 'xml' ? prettyXml(this.text()) : prettyJson(this.text()),
  );
  private readonly bytes = computed(() =>
    this.shape() === 'binary'
      ? base64Bytes(String((this.value() as { v?: unknown }).v ?? ''))
      : new Uint8Array(),
  );
  protected readonly hex = computed(() => hexDump(this.bytes()));
  protected readonly image = computed(() => {
    const type = imageType(this.bytes());
    return type ? `data:${type};base64,${(this.value() as { v: string }).v}` : undefined;
  });
  protected readonly dates = computed(() => dateForms(this.text()));

  /** Saves the value as it came: a binary with its bytes, anything else as text. */
  protected save() {
    const name = this.column().name || 'value';
    if (this.shape() === 'binary') {
      const bytes = this.bytes();
      void this.state.download(
        `${name}.bin`,
        () => new Blob([bytes.slice().buffer]),
        'application/octet-stream',
      );
    } else {
      const extension = this.shape() === 'json' ? 'json' : this.shape() === 'xml' ? 'xml' : 'txt';
      void this.state.download(`${name}.${extension}`, this.text(), 'text/plain');
    }
  }
}
