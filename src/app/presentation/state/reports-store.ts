import { signal } from '@angular/core';
import { Report, ReportUseCases } from '../../application/report-use-cases';
import type { WorkspaceState } from '../workspace-state';

/** Printable reports, and the one shown before printing it or saving it as PDF. */
export class ReportsStore {
  readonly report = signal<Report | undefined>(undefined);

  constructor(
    readonly reports: ReportUseCases,
    private readonly state: WorkspaceState,
  ) {}

  /** The request of the active tab with its response. */
  request() {
    const tab = this.state.active();
    const response = this.state.response();
    if (tab && response) this.report.set(this.reports.requestReport(tab.request, response));
  }
  /** The documentation of a collection. */
  collection(id: string) {
    const document = this.state.collections().find((d) => d.id === id);
    if (!document) return;
    try {
      this.report.set(this.reports.collectionDocs(document));
    } catch (error) {
      this.state.error.set(this.state.describe(error));
    }
  }
  close() {
    this.report.set(undefined);
    this.reports.release();
  }
}
