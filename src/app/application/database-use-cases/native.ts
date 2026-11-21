import {
  NativeAction,
  NativeForm,
  NativeRun,
  nativeOptions,
  nativeTimeout,
  readNativeRun,
} from '../../domain/db/native';
import { ExecutionPort } from '../ports';
import type { NativeRunPayload } from '../payloads';

/** The tool a connection would use, found on the computer. */
export interface LocatedTool {
  tool: string;
  path: string;
  version: string;
}

/** A run started: its id and the tool found for it. */
export interface Started {
  id: string;
  tool: string;
  version: string;
}

/** What a run asks for besides its options. */
export interface NativeRequest {
  workspace: string;
  connection: string;
  driver: string;
  action: NativeAction;
  form: NativeForm;
  /** The file or folder chosen in the dialog. */
  path: string;
  variables?: Readonly<Record<string, string>>;
  /** A restore: the database typed; on production, also confirmed. */
  confirmName?: string;
  confirm?: boolean;
}

/**
 * Backups, restores and scripts with the local client tools (DB-23, desktop only): the
 * backend finds the tool, checks the rules and starts it; its run is followed until it ends.
 */
export class DatabaseNativeCases {
  constructor(private readonly api: ExecutionPort) {}

  /** The tool for `need` in `folder`, or in the connection's folder or the usual places. */
  locate(
    workspace: string,
    connection: string,
    need: 'backup' | 'server' | 'archive' | 'plain' | 'script',
    folder?: string,
  ): Promise<LocatedTool> {
    return this.api.execute<LocatedTool>('native.locate', {
      workspace,
      connection,
      need,
      ...(folder?.trim() ? { folder: folder.trim() } : {}),
    });
  }

  /** Starts a run; its id and the tool found. */
  start(request: NativeRequest): Promise<Started> {
    const { form, action } = request;
    const timeoutSeconds = nativeTimeout(form);
    const payload: NativeRunPayload = {
      workspace: request.workspace,
      connection: request.connection,
      options: nativeOptions(action, form, request.path, request.driver),
      ...(form.database.trim() ? { database: form.database.trim() } : {}),
      ...(request.variables ? { variables: request.variables } : {}),
      ...(request.confirmName !== undefined ? { confirmName: request.confirmName } : {}),
      ...(request.confirm ? { confirm: true } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    };
    if (action === 'backup') return this.api.execute<Started>('native.backup', payload);
    if (action === 'restore') return this.api.execute<Started>('native.restore', payload);
    return this.api.execute<Started>('native.script', payload);
  }

  async status(id: string): Promise<NativeRun> {
    return readNativeRun(await this.api.execute('native.status', { id }));
  }

  async cancel(id: string): Promise<void> {
    await this.api.execute('native.cancel', { id });
  }
}
