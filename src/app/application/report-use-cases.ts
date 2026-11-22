import { PrintPort } from './ports';
import {
  ExecutionResponse,
  RequestDraft,
  Run,
  WorkspaceDocument,
  asCollection,
} from '../domain/models';
import {
  CollectionDocs,
  RequestReport,
  RunReport,
  collectionDocs,
  requestReport,
  runReport,
} from '../domain/reports';

/** A report ready to show and print, with the time it was made for its header. */
export type Report = { title: string; generatedAt: number } & (
  | { kind: 'run'; run: RunReport }
  | { kind: 'request'; request: RequestReport }
  | { kind: 'collection'; docs: CollectionDocs }
  | { kind: 'diagram'; diagram: DiagramReport }
);

/** An entity-relationship diagram (DB-20): its picture, and how many tables and relations. */
export interface DiagramReport {
  /** The diagram as an image (`data:image/svg+xml`), in the colors of the theme in use. */
  image: string;
  entities: number;
  relations: number;
  /** What the report says of it, when it is not a diagram (a chart of a result). */
  caption?: { key: string; params: Record<string, string | number> };
}

/**
 * Reports to print or save as PDF: a collection run, a request with its response, the
 * documentation of a collection and a database diagram. Credentials are hidden as on screen.
 */
export class ReportUseCases {
  constructor(
    private readonly printer: PrintPort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  runReport(run: Run, collection: string): Report {
    return {
      kind: 'run',
      title: collection || 'Collection run',
      generatedAt: this.now(),
      run: runReport(run, collection),
    };
  }
  requestReport(request: RequestDraft, response: ExecutionResponse): Report {
    return {
      kind: 'request',
      title: request.name || `${request.method} ${request.url}`,
      generatedAt: this.now(),
      request: requestReport(request, response),
    };
  }
  collectionDocs(document: WorkspaceDocument): Report {
    const docs = collectionDocs(asCollection(document.value));
    return {
      kind: 'collection',
      title: docs.name || document.name,
      generatedAt: this.now(),
      docs,
    };
  }
  diagramReport(title: string, diagram: DiagramReport): Report {
    return { kind: 'diagram', title: title || 'Diagram', generatedAt: this.now(), diagram };
  }
  /** Opens the system print dialog for the report shown in `sheet`, to print or save a PDF. */
  print(sheet: HTMLElement) {
    return this.printer.print(sheet);
  }
  /** Forgets the printed copy once the report is closed. */
  release() {
    this.printer.release();
  }
}
