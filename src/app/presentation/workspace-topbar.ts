import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { AppearanceSelector } from './appearance-selector';
import { LanguageSelector } from './language-selector';
import { StudioIcon } from './studio-icon';
import type { Workspace } from './workspace';

/** The top bar: brand, sections of the Canvas template, search, appearance and language. */
@Component({
  imports: [TranslocoPipe, FormField, AppearanceSelector, LanguageSelector, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-workspace-topbar',
  styles: ':host { display: contents; }',
  templateUrl: './workspace-topbar.html',
})
export class WorkspaceTopbar {
  readonly workspace = input.required<Workspace>();
  /** The search of the workspace, which Ctrl+K focuses. */
  readonly workspaceSearch = viewChild<ElementRef<HTMLInputElement>>('workspaceSearch');
}
