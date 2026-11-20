import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, model } from '@angular/core';

/** The tabs of Settings, each named in the language of the interface. */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-settings-tabs',
  template: `
    <div class="button-grid settings-nav">
      <button class="button" [class.selected]="tab() === 'general'" (click)="tab.set('general')">
        {{ 'General' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'modules'" (click)="tab.set('modules')">
        {{ 'Modules' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'vault'" (click)="tab.set('vault')">
        {{ 'Vault' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'ssh'" (click)="tab.set('ssh')">
        {{ 'SSH' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'masking'" (click)="tab.set('masking')">
        {{ 'Masking' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'oauth'" (click)="tab.set('oauth')">
        {{ 'OAuth' | transloco }}
      </button>
      <button
        class="button"
        [class.selected]="tab() === 'revisions'"
        (click)="tab.set('revisions')"
      >
        {{ 'Revisions' | transloco }}
      </button>
      <button class="button" [class.selected]="tab() === 'apis'" (click)="tab.set('apis')">
        {{ 'APIs' | transloco }}
      </button>
      <button
        class="button"
        [class.selected]="tab() === 'performance'"
        (click)="tab.set('performance')"
      >
        {{ 'Performance' | transloco }}
      </button>
    </div>
  `,
})
export class SettingsTabs {
  readonly tab = model('general');
}
