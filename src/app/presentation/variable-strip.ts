import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { ResolvedVariable } from '../domain/variables';

/** The `{{variables}}` a request uses, with the scope that gives each one its value. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-variable-strip',
  styleUrl: './variable-strip.scss',
  templateUrl: './variable-strip.html',
})
export class VariableStrip {
  readonly variables = input.required<ResolvedVariable[]>();
  /** Opens the variables, to define or change one. */
  readonly manage = output<void>();

  protected variableTitle(variable: ResolvedVariable) {
    if (!variable.defined) return 'Not defined in the active environment, collection or globals';
    if (variable.scope === 'dynamic') return 'Generated for each request';
    if (variable.scope === 'vault') return 'Resolved from your vault when sent';
    return variable.secret ? '••••••••' : (variable.value ?? '');
  }
}
