import { Health, Workspace, WorkspaceDocument } from '../domain/models';
import { SecretSummary } from '../domain/secrets';
import { ExecutionOperation, GitOperation } from './operations';
import { GitPayload, PayloadOf } from './payloads';

/**
 * A failed backend call with the stable error code the backend reported. A database's error
 * (`database.syntax`, `database.cancelled`…) brings its `detail`, such as where it failed.
 */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly detail?: unknown,
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
/** The person leaving the page: closing its tab or window, reloading it or going elsewhere. */
export interface PageExitPort {
  /**
   * Calls `leave` as the page goes. It answers whether it closed something the page would
   * still show if it came back from the browser's back-forward cache.
   */
  onExit(leave: () => boolean): void;
  /** Sends an operation that must reach the backend while the page goes, without an answer. */
  send(...args: ExecuteArgs): void;
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
/** A file to import, chosen by the person and read in chunks. */
export interface TransferSource {
  readonly name: string;
  readonly size: number;
  /** Bytes from `offset`, at most `length`; none past the end. */
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
/** Where an export is written, chosen by the person, in pieces of text. */
export interface TransferTarget {
  readonly name: string;
  write(text: string): Promise<void>;
  /** Appends bytes: an Excel workbook is not text. */
  writeBytes(bytes: Uint8Array): Promise<void>;
  /** Ends the file: the web version downloads it then. */
  close(): Promise<void>;
  /** Drops what was written, as a cancelled export. */
  discard(): Promise<void>;
}
/**
 * Files of imports and exports. The web version reads the file chosen in the browser and
 * downloads the export; the desktop app opens and saves files with the system dialogs.
 */
export interface TransferFilesPort {
  /** A file to import, among `extensions`; `undefined` when the person cancels. */
  open(extensions: readonly string[]): Promise<TransferSource | undefined>;
  /** Where to write an export named `name`; `undefined` when the person cancels. */
  save(name: string, extension: string, type: string): Promise<TransferTarget | undefined>;
}
/**
 * The file of a database that lives in one (SQLite), chosen in the desktop app's dialog. Its
 * path is saved in the connection, and the driver opens only that file.
 */
export interface DatabaseFilesPort {
  /** Only the desktop app has the dialog; the web version types the path. */
  readonly available: boolean;
  /** A file to open, or where to make a new one; `undefined` when the person cancels. */
  choose(create: boolean): Promise<string | undefined>;
}
/**
 * The files and folders of the local client tools (DB-23), chosen in the desktop app's
 * dialogs: the folder of the tools, where a backup goes and the file a restore or script
 * reads. The web version has none, and the backend refuses those runs there.
 */
export interface NativeFilesPort {
  readonly available: boolean;
  /** A folder, where to save (with `name` proposed) or a file to open; `undefined` when the
   * person cancels. */
  choose(purpose: 'folder' | 'save' | 'open', name?: string): Promise<string | undefined>;
}
/** Prints a report shown on screen, where the system lets the person save it as PDF. */
export interface PrintPort {
  print(sheet: HTMLElement): Promise<void>;
  /** Removes what was prepared for printing. */
  release(): void;
}
/** Small device-local preferences, such as the active environment of each workspace. */
export interface PreferencePort {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}
/** Whether the system shows notifications: allowed, refused, not asked yet or unavailable. */
export type NotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported';
/** System notifications (the desktop's own, through the web `Notification` API). */
export interface NotificationPort {
  permission(): NotificationPermission;
  /** Asks the person once; browsers allow it only right after a click. */
  request(): Promise<NotificationPermission>;
  show(title: string, body: string): void;
}
/** Where there are no notifications (tests, servers). */
export const noNotifications: NotificationPort = {
  permission: () => 'unsupported',
  request: () => Promise.resolve('unsupported'),
  show: () => undefined,
};
