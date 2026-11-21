import { Signal, signal } from '@angular/core';
import {
  testedServers,
  type DbDestination,
  type DbRouteReport,
  type DbTestReport,
} from '../../application/database-use-cases';
import { ApiFailure } from '../../application/ports';
import type { DbConnectionValue } from '../../domain/db/connection';
import { DbForm, typedSecrets, valueOf } from '../../domain/db/form';
import type { DbSection } from '../db-panel/section';
import type { PanelTask } from '../panel-task';

/** What the checks of the connection form need from it. */
export interface CheckedForm {
  section: DbSection;
  task: PanelTask;
  model: Signal<DbForm>;
  /** The saved connection's value, whose vault references the form keeps. */
  stored: Signal<DbConnectionValue>;
  /** Whether the connection is saved. */
  saved: () => boolean;
  /** The id the connection is saved with; its vault entries are named after it. */
  id: () => string;
  /** The engine's usual port, for a form without one. */
  defaultPort: () => number | undefined;
  /** Says the form cannot be checked yet, as a message key; empty when it can. */
  problem: Signal<string>;
  /** Secrets of a connection never saved went to the vault. */
  typedUnsaved: () => void;
}

/**
 * «Test connection» and «Test the tunnel» of the connection form, as it is written: typed
 * secrets go to the vault first, and each server the test reached, or was refused, is said.
 */
export class ConnectionChecks {
  readonly report = signal<DbTestReport | undefined>(undefined);
  /** What the last «Test the tunnel» said. */
  readonly tunnel = signal<DbRouteReport | undefined>(undefined);
  /** Each server the last test asked to reach, and whether the egress policy let it. */
  readonly servers = signal<readonly DbDestination[]>([]);

  constructor(private readonly form: CheckedForm) {}

  clear() {
    this.report.set(undefined);
    this.tunnel.set(undefined);
    this.servers.set([]);
  }

  private prepare() {
    const problem = this.form.problem();
    if (problem) throw new Error(problem);
    const model = this.form.model();
    const typed = typedSecrets(model);
    if (!this.form.saved() && (typed.password || typed.keyPem || typed.proxyPassword))
      this.form.typedUnsaved();
    return { model, typed, value: valueOf(model, this.form.stored()) };
  }

  test() {
    this.report.set(undefined);
    this.servers.set([]);
    const { section, task } = this.form;
    void task.run(async () => {
      const { model, typed, value } = this.prepare();
      if (!(await section.ensure(model.driver))) return;
      const cases = await section.cases();
      try {
        const report = await cases.connections.test(
          section.state.workspaceId(),
          this.form.id(),
          value,
          typed,
          section.state.scopes(),
        );
        this.report.set(report);
        this.servers.set(report.servers ?? []);
      } catch (error) {
        this.servers.set(testedServers((error as ApiFailure).detail));
        throw error;
      }
    });
  }

  /** «Test the tunnel»: the server reached through the proxy or the SSH tunnel, no session. */
  testRoute() {
    this.tunnel.set(undefined);
    const { section, task } = this.form;
    void task.run(async () => {
      const { typed, value } = this.prepare();
      const cases = await section.cases();
      this.tunnel.set(
        await cases.connections.testRoute(
          section.state.workspaceId(),
          this.form.id(),
          value,
          typed,
          section.state.scopes(),
          this.form.defaultPort(),
        ),
      );
    });
  }
}
