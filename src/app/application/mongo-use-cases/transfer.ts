import { WorkspaceDocument } from '../../domain/models';
import { TransferValue, transferValue } from '../../domain/mongo-transfer';
import { TransferSource, TransferTarget } from '../ports';
import { MongoPorts } from './payload';
import { exportToFile, sampleFields } from './transfer-export';
import { copiedDocuments, fileDocuments, importDocuments, previewFile } from './transfer-import';
import {
  ExportFormat,
  ExportSource,
  FileImport,
  ImportPlan,
  TransferEnd,
  TransferOutcome,
  TransferProgress,
} from './transfer-types';

/**
 * Imports and exports of collections: to and from JSON and CSV files, to another collection
 * (of this connection or another), and saved in the workspace to run them again.
 */
export class MongoTransferCases {
  constructor(
    private readonly api: MongoPorts,
    private readonly id: () => string,
  ) {}

  /** The fields of the first documents, for the columns of a CSV export. */
  fields(source: ExportSource): Promise<string[]> {
    return sampleFields(this.api, source);
  }

  export(
    source: ExportSource,
    format: ExportFormat,
    file: TransferTarget,
    progress: (documents: number) => void,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    return exportToFile(this.api, source, format, file, progress, signal);
  }

  /** The first documents of a file, and its CSV header. */
  preview(file: TransferSource) {
    return previewFile(file);
  }

  import(
    destination: TransferEnd,
    plan: FileImport,
    file: TransferSource,
    progress: (progress: TransferProgress) => void,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    let read: TransferProgress = { documents: 0, bytes: 0, total: file.size };
    return importDocuments(
      this.api,
      destination,
      plan,
      fileDocuments(file, plan, (now) => progress((read = now)), signal),
      (documents) => progress({ ...read, documents }),
      signal,
    );
  }

  /** Copies the documents of a collection or query to another collection. */
  copy(
    source: ExportSource,
    destination: TransferEnd,
    plan: ImportPlan,
    progress: (documents: number) => void,
    signal: AbortSignal,
  ): Promise<TransferOutcome> {
    return importDocuments(
      this.api,
      destination,
      plan,
      copiedDocuments(this.api, source, signal),
      progress,
      signal,
    );
  }

  /** Saves a transfer in the workspace, to run it again. */
  save(
    workspace: string,
    name: string,
    value: TransferValue,
    existing?: WorkspaceDocument,
  ): Promise<WorkspaceDocument> {
    return this.api.save({
      id: existing?.id ?? this.id(),
      workspace_id: workspace,
      kind: 'mongo-transfer',
      name: name.trim() || `${value.direction} ${value.database}.${value.collection}`,
      revision: existing?.revision ?? 0,
      updated_at: existing?.updated_at ?? 0,
      value: transferValue(value),
    });
  }

  remove(document: WorkspaceDocument): Promise<void> {
    return this.api.remove(document);
  }
}
