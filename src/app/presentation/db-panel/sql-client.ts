import { signal } from '@angular/core';
import {
  ClientCommand,
  ScriptPart,
  scriptParts,
  withClientVariables,
} from '../../domain/db/client-commands';
import { readScript } from '../../domain/db/sql';
import { ExportFormat, exportFormatOf } from '../../domain/db/transfer/export';
import { ParameterStyle, bindParameters, parametersOf } from '../../domain/db/sql-params';
import type { SqlRunner } from './sql-runner';

/** Scripts a script may include, one inside another, at most. */
const INCLUDES = 5;

/** What the person gave a parameter: its text and how it is sent. */
export interface ParameterValue {
  text: string;
  as: 'text' | 'number' | 'null';
}

/** The question for the parameters of a statement. */
export interface ParametersQuestion {
  names: string[];
  positional: number;
  remembered: Record<string, string>;
  answer: (values: Record<string, ParameterValue> | undefined) => void;
}

const valueOf = (given: ParameterValue | undefined): unknown =>
  !given || given.as === 'null' ? null : given.as === 'number' ? Number(given.text) : given.text;

/**
 * What a SQL tab does by itself, as DBeaver's client side: the `@` commands of a script and
 * its `${variables}`, and the parameters of a statement asked for and bound.
 */
export class ScriptClient {
  readonly variables = signal<ReadonlyMap<string, string>>(new Map());
  readonly question = signal<ParametersQuestion | undefined>(undefined);
  private depth = 0;
  /** `@export`: the format the next query is exported in, instead of running here. */
  private exporting: ExportFormat | undefined;

  constructor(private readonly runner: SqlRunner) {}

  setVariable(name: string, value: string) {
    this.variables.update((all) => new Map(all).set(name, value));
  }
  unsetVariable(name: string) {
    this.variables.update((all) => {
      const next = new Map(all);
      next.delete(name);
      return next;
    });
  }

  /** After `@export`, sends the query to the export wizard; `true` when it did. */
  exportNext(sql: string): boolean {
    const format = this.exporting;
    if (!format) return false;
    this.exporting = undefined;
    const connection = this.runner.connection()?.id;
    if (!connection) return false;
    this.runner.section.transferRequest.set({
      kind: 'export',
      connection,
      sql: this.withVariables(sql),
      name: 'export',
      format,
    });
    return true;
  }

  /** The text with its `${variables}` replaced. */
  withVariables(sql: string) {
    return withClientVariables(sql, this.variables());
  }

  /** The parts of a script, or nothing (said in the messages) when a command is wrong. */
  parts(text: string): ScriptPart[] | undefined {
    try {
      return scriptParts(text);
    } catch (error) {
      const failed = error as Error & { params?: Record<string, string>; line?: number };
      this.runner.results.note({
        kind: 'error',
        text: failed.message,
        ...(failed.params ? { params: failed.params } : {}),
      });
      return undefined;
    }
  }

  /** Does a client command; `false` stops the script. */
  async command(command: ClientCommand): Promise<boolean> {
    const note = this.runner.results.note.bind(this.runner.results);
    switch (command.kind) {
      case 'set':
        this.setVariable(command.name, command.value);
        return true;
      case 'unset':
        this.unsetVariable(command.name);
        return true;
      case 'echo':
        note({ kind: 'info', text: 'db.client.echo', params: { v0: command.text } });
        return true;
      case 'export': {
        const format = exportFormatOf(command.options);
        if (!format) {
          note({ kind: 'error', text: 'db.client.export', params: { v0: command.options } });
          return false;
        }
        this.exporting = format;
        return true;
      }
      case 'include': {
        const found = this.runner.section
          .scripts()
          .find((document) => document.name.toLowerCase() === command.script.toLowerCase());
        if (!found || this.depth >= INCLUDES) {
          note({ kind: 'error', text: 'db.client.notIncluded', params: { v0: command.script } });
          return false;
        }
        this.depth++;
        try {
          await this.runner.runScript(readScript(found.value).sql);
        } finally {
          this.depth--;
        }
        return true;
      }
    }
  }

  /**
   * The statement with its parameters bound as the driver binds them, after asking their
   * values; undefined when the person cancels.
   */
  async bind(
    sql: string,
    style: ParameterStyle,
  ): Promise<{ sql: string; params: unknown[] } | undefined> {
    const found = parametersOf(sql, style === 'question');
    if (!found.names.length && !found.positional) return { sql, params: [] };
    const cases = await this.runner.section.cases();
    const values = await new Promise<Record<string, ParameterValue> | undefined>((done) =>
      this.question.set({
        ...found,
        remembered: cases.assist.parameters(),
        answer: (given) => {
          this.question.set(undefined);
          done(given);
        },
      }),
    );
    if (!values) return undefined;
    cases.assist.remember(
      Object.fromEntries(found.names.map((name) => [name, values[name]?.text ?? ''])),
    );
    const named = Object.fromEntries(found.names.map((name) => [name, valueOf(values[name])]));
    const positional = Array.from({ length: found.positional }, (_, at) =>
      valueOf(values[`${at + 1}`]),
    );
    return bindParameters(sql, style, named, positional);
  }
}
