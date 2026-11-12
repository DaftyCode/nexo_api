import { computed, effect, signal, untracked } from '@angular/core';

export type SettingsTab = 'variables' | 'authorization' | 'scripts';

/**
 * Where the person is: the section shown, the way back to the previous ones, the console and
 * the collection or folder whose settings are open.
 */
export class NavigationStore {
  readonly section = signal('collections');
  /** Sections left to reach the current one, most recent last, for "Back". */
  private readonly trail = signal<string[]>([]);
  /** Where "Back" returns to, or nothing at the first section. */
  readonly backSection = computed(() => this.trail().at(-1) ?? '');
  private shownSection = this.section();
  private returning = false;
  readonly consoleOpen = signal(false);
  /** Collection whose variables, auth and scripts are edited in the collection settings view. */
  readonly settingsCollectionId = signal('');
  /** Folder of that collection being edited; empty for the collection itself. */
  readonly settingsPath = signal<number[]>([]);
  readonly settingsTab = signal<SettingsTab>('variables');

  constructor() {
    effect(() => {
      const now = this.section();
      untracked(() => {
        if (now === this.shownSection) return;
        if (this.returning) this.returning = false;
        else
          this.trail.update((trail) =>
            [...trail.filter((x) => x !== now), this.shownSection].slice(-20),
          );
        this.shownSection = now;
      });
    });
  }

  /** Returns to the section shown before this one, as a browser's back button. */
  goBack() {
    const trail = this.trail();
    const previous = trail.at(-1);
    if (!previous) return;
    this.returning = true;
    this.trail.set(trail.slice(0, -1));
    this.section.set(previous);
  }
  /** Opens the settings of a collection or, with a path, of one of its folders. */
  openSettings(id: string, path: number[] = [], tab: SettingsTab = 'variables') {
    this.settingsCollectionId.set(id);
    this.settingsPath.set(path);
    this.settingsTab.set(tab);
    this.section.set('collection-settings');
  }
}
