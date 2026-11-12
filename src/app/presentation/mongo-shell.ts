import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { shellText } from '../domain/bson';
import { ShellAnswer } from '../domain/mongo-shell';
import type { MongoExplorer } from './mongo-explorer';

/**
 * The shell of a connection: commands as in mongosh (`db.orders.find()`, `use`, `show`),
 * their output, a question before a destructive one, and the history of commands.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-shell',
  styleUrls: ['./mongo-explorer.scss', './mongo-shell.scss'],
  templateUrl: './mongo-shell.html',
  // The keys reach the shell from its command editor.
  host: { '(keydown)': 'keydown($event)' },
})
export class MongoShell {
  readonly explorer = input.required<MongoExplorer>();
  protected readonly console = computed(() => this.explorer().shell);
  /** The history, the newest first. */
  protected readonly recent = computed(() => [...this.console().history()].reverse());

  /** A value as the shell writes it; texts as they are, documents one after another. */
  protected text(answer: ShellAnswer): string {
    const value = answer.value;
    if (typeof value === 'string') return value;
    if (answer.kind === 'documents' && Array.isArray(value))
      return value.map((document) => shellText(document)).join('\n');
    return shellText(value);
  }
  protected count(answer: ShellAnswer): number {
    return Array.isArray(answer.value) ? answer.value.length : 0;
  }
  protected keydown(event: KeyboardEvent) {
    const console = this.console();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void console.run();
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      console.recall(event.key === 'ArrowUp' ? 1 : -1);
    }
  }
}
