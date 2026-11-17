import { signal } from '@angular/core';
import type { DatabaseUseCases, DriverHello } from '../../application/database-use-cases';
import { readDbConnection } from '../../domain/db/connection';
import { QueryStyle } from '../../domain/db/table-query';
import { QuoteStyle } from '../../domain/db/tree';
import { WorkspaceDocument } from '../../domain/models';

/** What the section gives: its connections, its use cases and the workspace. */
export interface DriverContext {
  connection(id: string): WorkspaceDocument | undefined;
  cases(): Promise<DatabaseUseCases>;
  workspace(): string;
}

/**
 * What the driver of each connection said about itself (`db.dialect`), asked once: how it
 * quotes names, its dialect, and what it can do with transactions.
 */
export class DriverFacts {
  private readonly hellos = signal<Readonly<Record<string, DriverHello>>>({});

  constructor(private readonly context: DriverContext) {}

  private driver(connection: string) {
    return readDbConnection(this.context.connection(connection)?.value).driver;
  }

  /** How the driver of a connection quotes names; plain double quotes until it says. */
  quoteStyle(connection: string): QuoteStyle {
    return this.hellos()[this.driver(connection)]?.dialect ?? { quoteOpen: '"', quoteClose: '"' };
  }
  /** How the driver of a connection writes SQL: its quotes and its dialect's name. */
  sqlStyle(connection: string): QueryStyle {
    const style = this.quoteStyle(connection) as QuoteStyle & { name?: string };
    return { ...style, name: style.name ?? '' };
  }
  /** What the driver of a connection can do, once it said. */
  capabilities(connection: string): DriverHello['capabilities'] | undefined {
    return this.hellos()[this.driver(connection)]?.capabilities;
  }

  /** Asks the driver of a connection about itself, once. */
  async learn(connection: string) {
    const driver = this.driver(connection);
    if (!driver || this.hellos()[driver]) return;
    const hello = await (
      await this.context.cases()
    ).navigator.hello(this.context.workspace(), driver);
    this.hellos.update((all) => ({ ...all, [driver]: hello }));
  }
}
