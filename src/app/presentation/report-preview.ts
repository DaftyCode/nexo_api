import { TranslocoPipe } from '@jsverse/transloco';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, inject, viewChild } from '@angular/core';
import { WorkspaceState } from './workspace-state';

/**
 * A report as it will be printed: a run, a request with its response, or the documentation
 * of a collection. "Print or save as PDF" opens the system dialog, where PDF is one of the
 * printers.
 */
@Component({
  imports: [TranslocoPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-report-preview',
  styleUrl: './report-preview.scss',
  templateUrl: './report-preview.html',
})
export class ReportPreview {
  protected readonly state = inject(WorkspaceState);
  private readonly sheet = viewChild<ElementRef<HTMLElement>>('sheet');

  protected async print() {
    const sheet = this.sheet()?.nativeElement;
    if (!sheet) return;
    try {
      await this.state.reports.print(sheet);
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  protected close() {
    this.state.closeReport();
  }
  /** Indentation of a documentation entry by its depth in the folders. */
  protected indent(depth: number) {
    return `${Math.min(depth, 6) * 14}px`;
  }
}
