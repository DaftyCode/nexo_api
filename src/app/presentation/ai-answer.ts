import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { AiPlace, AiStep, AiUse, answerParts, codeActions, stepLabel } from '../domain/ai';
import { WorkspaceState, success } from './workspace-state';

/**
 * An answer of the assistant (IA-01): the tools it read with, its prose, and its blocks of
 * code, each with the buttons of the place it was asked in (add to the tests, open or run a
 * query, use it in the MongoDB query) once the answer has ended.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-answer',
  templateUrl: './ai-answer.html',
  styleUrl: './ai-answer.scss',
})
export class AiAnswer {
  private readonly state = inject(WorkspaceState);
  readonly text = input('');
  readonly steps = input<readonly AiStep[] | undefined>(undefined);
  readonly place = input.required<AiPlace>();
  /** The answer ended: its code can be used. */
  readonly actionable = input(true);
  readonly use = output<AiUse>();
  protected readonly parts = computed(() => answerParts(this.text()));
  protected readonly label = stepLabel;

  protected actions(language: string) {
    return this.actionable() ? codeActions(this.place(), language) : [];
  }

  protected copy(code: string) {
    void globalThis.navigator?.clipboard?.writeText(code);
    this.state.tell(success('Copied to the clipboard'));
  }
}
