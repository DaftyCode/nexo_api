import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, DOCUMENT, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DocsData, DocsStart, DocsTesting, DocsTools, DocsWorkspace } from './sections';

/**
 * The documentation: an index on the left, always in view, and every section at the full
 * width of the window. The index scrolls to a section without leaving the page.
 */
@Component({
  imports: [TranslocoPipe, RouterLink, DocsStart, DocsTesting, DocsTools, DocsData, DocsWorkspace],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-docs-page',
  templateUrl: './docs-page.html',
})
export class DocsPage {
  private readonly document = inject(DOCUMENT);
  /** The section last chosen in the index. */
  protected readonly active = signal('');

  protected go(event: Event, id: string) {
    event.preventDefault();
    this.active.set(id);
    this.document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }
}
