import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, signal, computed } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { ExecutionResponse, formatJson } from '../domain/models';
import { StudioIcon } from './studio-icon';

@Component({
  imports: [TranslocoPipe, JsonPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-response-view',
  styleUrl: './response-view.scss',
  templateUrl: './response-view.html',
})
export class ResponseView {
  readonly response = input<ExecutionResponse>();
  readonly running = input(false);
  protected readonly tab = signal('body');
  protected readonly pretty = signal(true);
  protected readonly text = computed(() => {
    const body = this.response()?.body ?? '';
    return this.pretty() ? formatJson(body) : body;
  });
  protected readonly passed = computed(
    () => this.response()?.assertions?.filter((x) => x.passed).length ?? 0,
  );
}
