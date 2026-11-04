import { Health, Workspace, WorkspaceDocument } from '../domain/models';
import { ExecutionOperation, GitOperation } from './operations';

/** A failed backend call with the stable error code the backend reported. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
export function failureCode(error: unknown): string | undefined {
  return error instanceof ApiFailure ? error.code : undefined;
}

export interface RuntimePort {
  initialize(): Promise<void>;
  health(): Promise<Health>;
}
/** The browser session of the web version; the desktop window needs none. */
export interface SessionPort {
  signOut(): Promise<void>;
}
export interface WorkspaceRepositoryPort {
  workspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
}
/** A stored version of a document. */
export interface RevisionEntry {
  revision: number;
  changed_at: number;
  value: WorkspaceDocument;
}
export interface DocumentRepositoryPort {
  /** Every document; history entries and runs come without their value. */
  documents(workspace: string): Promise<WorkspaceDocument[]>;
  document(id: string): Promise<WorkspaceDocument>;
  save(document: WorkspaceDocument): Promise<WorkspaceDocument>;
  remove(document: WorkspaceDocument): Promise<void>;
  revisions(id: string): Promise<RevisionEntry[]>;
}
export interface ExecutionPort {
  execute<T>(operation: ExecutionOperation, payload: unknown): Promise<T>;
}
export interface VersionControlPort {
  git<T>(operation: GitOperation, payload: unknown): Promise<T>;
}
export interface SecretVaultPort {
  putSecret(name: string, value: string): Promise<void>;
  removeSecret(name: string): Promise<void>;
  secretNames(): Promise<string[]>;
}
/** Aggregate supplied only by the composition root; each contract is independently replaceable. */
export interface ApiPort
  extends
    RuntimePort,
    SessionPort,
    WorkspaceRepositoryPort,
    DocumentRepositoryPort,
    ExecutionPort,
    VersionControlPort,
    SecretVaultPort {}
export interface FilePort {
  download(name: string, content: string | Blob, type?: string): void;
  read(file: File): Promise<string>;
  id(): string;
}
/** Small device-local preferences, such as the active environment of each workspace. */
export interface PreferencePort {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}
