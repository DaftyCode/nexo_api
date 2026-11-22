import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MOCK_CATALOGS, MockGenerator } from '../../domain/db/mock';

/** The settings of one generator of test data: its range, list, pattern, catalog… */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-mock-settings',
  templateUrl: './settings.html',
  styles: `
    .db-mock-settings {
      display: flex;
      gap: var(--nexo-space-2);
    }
    .db-mock-settings input {
      width: calc(var(--nexo-size-unit) * 50);
    }
  `,
})
export class DbMockSettings {
  readonly generator = input.required<MockGenerator>();
  /** The table a foreign column references. */
  readonly foreign = input<string | undefined>(undefined);
  readonly changed = output<Record<string, unknown>>();
  protected readonly catalogs = MOCK_CATALOGS;

  protected number(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }
  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected list(event: Event): string[] {
    return this.text(event)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
}
