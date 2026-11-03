import { Health, Session, Workspace, WorkspaceDocument } from '../domain/models';
export interface RuntimePort {
  initialize(): Promise<void>;
  health(): Promise<Health>;
}
export interface IdentityPort {
  authenticate(
    mode: 'login' | 'register',
    credentials: { email: string; password: string; name: string },
  ): Promise<Session>;
  signOut(): Promise<void>;
}
export interface WorkspaceRepositoryPort {
  workspaces(): Promise<Workspace[]>;
  createWorkspace(name: string): Promise<Workspace>;
  members(workspace: string): Promise<unknown[]>;
  addMember(workspace: string, email: string, role: string): Promise<void>;
}
export interface DocumentRepositoryPort {
  documents(workspace: string): Promise<WorkspaceDocument[]>;
  save(document: WorkspaceDocument): Promise<WorkspaceDocument>;
  remove(document: WorkspaceDocument): Promise<void>;
  revisions(
    id: string,
  ): Promise<
    { revision: number; changed_at: number; actor_id: string; value: WorkspaceDocument }[]
  >;
}
export interface ExecutionPort {execute<T>(operation: string, payload: unknown): Promise<T>;}
export interface VersionControlPort {git<T>(operation: string, payload: unknown): Promise<T>;}
export interface SecretVaultPort {
  putSecret(name: string, value: string): Promise<void>;
  removeSecret(name: string): Promise<void>;
}
/** Aggregate supplied only by the composition root; each contract is independently replaceable. */
export interface ApiPort extends RuntimePort,IdentityPort,WorkspaceRepositoryPort,DocumentRepositoryPort,ExecutionPort,VersionControlPort,SecretVaultPort {}
export interface FilePort {
  download(name: string, content: string, type?: string): void;
  read(file: File): Promise<string>;
  id(): string;
}
