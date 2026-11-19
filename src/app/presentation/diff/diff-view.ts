import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { syntaxHighlighting } from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import type { MergeView } from '@codemirror/merge';
import { codeScheme, followCodeScheme, highlight, readOnly } from '../code-editor-setup';
import { CodeLanguage, languageSupport } from '../code-editor';

/** Changed lines and text in the colours of the theme: what the first side had, and the second. */
const changes = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, & .cm-deletedChunk': {
    background: 'var(--nexo-color-danger-soft)',
  },
  '&.cm-merge-b .cm-changedLine': { background: 'var(--nexo-color-success-soft)' },
  '&.cm-merge-a .cm-changedText, & .cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--nexo-color-danger) 30%, transparent)',
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'color-mix(in srgb, var(--nexo-color-success) 30%, transparent)',
  },
  '&.cm-merge-a .cm-changedLineGutter': { background: 'var(--nexo-color-danger)' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--nexo-color-success)' },
  '& .cm-collapsedLines': {
    background: 'var(--nexo-color-surface)',
    color: 'var(--nexo-color-text-muted)',
  },
});

/**
 * Two texts side by side with what changed marked, long stretches without changes folded,
 * and buttons that go to the previous or next difference in both at once. The texts are
 * read, selected and searched (Ctrl+F), never edited.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-diff-view',
  templateUrl: './diff-view.html',
  styleUrl: './diff-view.scss',
})
export class DiffView {
  readonly source = input.required<string>();
  readonly target = input.required<string>();
  readonly language = input<CodeLanguage>('text');
  /** The names of both sides, above each one and for screen readers. */
  readonly sourceLabel = input.required<string>();
  readonly targetLabel = input.required<string>();
  /** Blocks of lines that differ, and the one shown (from 1; 0 before going to one). */
  protected readonly total = signal(0);
  protected readonly shown = signal(0);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: MergeView | undefined;
  /** Both texts turn dark or light with the template. */
  private readonly dark = followCodeScheme(() => this.view?.a);
  /** Each build waits for its language: only the last one asked for is kept. */
  private build = 0;
  private rendered = false;

  constructor() {
    followCodeScheme(() => this.view?.b);
    afterNextRender(() => {
      this.rendered = true;
      void this.create();
    });
    effect(() => {
      this.source();
      this.target();
      this.language();
      this.sourceLabel();
      this.targetLabel();
      untracked(() => {
        if (this.rendered) void this.create();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.build += 1;
      this.view?.destroy();
    });
  }

  private side(label: string, language: Extension): Extension[] {
    return [
      lineNumbers(),
      drawSelection(),
      keymap.of(searchKeymap),
      syntaxHighlighting(highlight),
      readOnly(true),
      language,
      changes,
      codeScheme(this.dark()),
      EditorView.contentAttributes.of({ 'aria-label': label, tabindex: '0' }),
    ];
  }

  private async create() {
    const build = ++this.build;
    const [{ MergeView }, language] = await Promise.all([
      import('@codemirror/merge'),
      languageSupport(this.language()),
    ]);
    if (build !== this.build) return;
    this.view?.destroy();
    this.view = new MergeView({
      a: { doc: this.source(), extensions: this.side(this.sourceLabel(), language) },
      b: { doc: this.target(), extensions: this.side(this.targetLabel(), language) },
      parent: this.host().nativeElement,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
      // Big bodies fall back to a faster, less precise diff instead of blocking the page.
      diffConfig: { scanLimit: 500, timeout: 500 },
    });
    this.total.set(this.view.chunks.length);
    this.shown.set(0);
  }

  /** Goes to the previous (`-1`) or next (`1`) block that differs, in both texts. */
  protected go(step: -1 | 1) {
    const view = this.view;
    const total = view?.chunks.length ?? 0;
    if (!view || !total) return;
    const next = Math.min(Math.max(this.shown() + step, 1), total);
    const chunk = view.chunks[next - 1];
    this.shown.set(next);
    for (const [editor, at] of [
      [view.a, Math.min(chunk.fromA, view.a.state.doc.length)],
      [view.b, Math.min(chunk.fromB, view.b.state.doc.length)],
    ] as const) {
      editor.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
      });
    }
  }
}
