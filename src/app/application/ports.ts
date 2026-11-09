import { Health, Workspace, WorkspaceDocument } from '../domain/models';
import { SecretSummary } from '../domain/secrets';
import { ExecutionOperation, GitOperation } from './operations';
import { GitPayload, PayloadOf } from './payloads';

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
/**
 * An operation with its payload. Written as one tuple per operation so the payload is checked
 * against the operation's generated type even when the result type is given explicitly.
 */
export type ExecuteArgs = {
  [O in ExecutionOperation]: [operation: O, payload: PayloadOf<O>];
}[ExecutionOperation];
export interface ExecutionPort {
  execute<T>(...args: ExecuteArgs): Promise<T>;
}
export interface VersionControlPort {
  git<T>(operation: GitOperation, payload: GitPayload): Promise<T>;
}
export interface SecretVaultPort {
  /** Saves a value, allowed domains or both; what is not given is kept. */
  putSecret(name: string, value?: string, allowedHosts?: string[]): Promise<void>;
  removeSecret(name: string): Promise<void>;
  secrets(): Promise<SecretSummary[]>;
}
/** How a sign-in window ended. */
export type SignInWindowOutcome =
  { outcome: 'returned'; url: string } | { outcome: 'closed' } | { outcome: 'replaced' };
/**
 * A browser window inside the desktop app for OAuth 2.0 sign-ins, as Postman has: it stops at
 * the Callback URL and gives back that address, so any Callback URL works without pasting.
 */
export interface SignInWindowPort {
  /** Whether this build has one (the desktop app); the web version uses the system browser. */
  readonly available: boolean;
  open(url: string, callbackUrl: string): Promise<SignInWindowOutcome>;
  /** Closes the window if it is open; its `open` call ends as `closed`. */
  close(): Promise<void>;
}
/** Without a sign-in window: the web version. */
export const noSignInWindow: SignInWindowPort = {
  available: false,
  open: () => Promise.resolve({ outcome: 'closed' }),
  close: () => Promise.resolve(),
};
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
  /** The bytes of a file, in base64. */
  readBase64(file: File): Promise<string>;
  id(): string;
}
/** Small device-local preferences, such as the active environment of each workspace. */
export interface PreferencePort {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}
