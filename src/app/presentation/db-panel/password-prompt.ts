import { signal } from '@angular/core';
import type { DatabaseUseCases } from '../../application/database-use-cases';
import type { DialogRequest } from '../mongo-dialog';

/** A password the section is asking for, and what to do with the answer. */
export interface PasswordRequest {
  request: DialogRequest;
  answer: (password: string | undefined) => void;
}

/**
 * Asks for the password of a connection that keeps none (DB-25) when one of its sessions
 * opens. The password goes only to the engine, which keeps it while a session of the
 * connection is open; nothing here keeps it.
 */
export class PasswordPrompts {
  readonly request = signal<PasswordRequest | undefined>(undefined);

  /** Resolves with the password typed, or `undefined` when the person cancels. */
  readonly ask = (connection: string): Promise<string | undefined> =>
    new Promise((done) => {
      // A second question replaces the first: that one is cancelled.
      this.request()?.answer(undefined);
      this.request.set({
        request: {
          title: 'Password of the connection',
          message: { key: 'db.password.ask', params: { v0: connection } },
          first: { label: 'Password', value: '', secret: true },
          confirm: 'Connect',
        },
        answer: (password) => {
          this.request.set(undefined);
          done(password);
        },
      });
    });

  /**
   * The loader of the use cases, with these questions set from its first use. It answers the
   * same promise, so its callers wait no longer, and the questions are set before they go on.
   */
  asking(loader: () => Promise<DatabaseUseCases>): () => Promise<DatabaseUseCases> {
    let set = false;
    return () => {
      const loading = loader();
      if (!set) void loading.then((cases) => cases.sessions.askPasswordsWith(this.ask));
      set = true;
      return loading;
    };
  }
}
