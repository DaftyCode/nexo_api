import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { FieldTree, FormField } from '@angular/forms/signals';
import { TranslocoPipe } from '@jsverse/transloco';
import { CompareSideForm } from '../../domain/response-compare';
import { WorkspaceState } from '../workspace-state';
import { CompareStore } from './compare-store';

/**
 * Where one of the compared responses comes from: sending the request of the tab with an
 * environment, the response a tab shows, an entry of the history, or a response of a
 * collection run.
 */
@Component({
  imports: [TranslocoPipe, FormField, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-compare-side',
  templateUrl: './compare-side.html',
})
export class CompareSide {
  readonly fields = input.required<FieldTree<CompareSideForm>>();
  /** The name of this side: first or second response. */
  readonly legend = input.required<string>();
  protected readonly store = inject(CompareStore);
  protected readonly state = inject(WorkspaceState);

  protected tabName(id: string) {
    const request = this.state.tabs().find((tab) => tab.id === id)?.request;
    return request?.name || `${request?.method ?? ''} ${request?.url ?? ''}`;
  }
}
