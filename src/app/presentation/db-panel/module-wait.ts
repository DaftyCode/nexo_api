import { WritableSignal } from '@angular/core';
import { ModuleSummary } from '../../domain/modules';
import type { ModuleNeed } from '../../application/modules-use-cases';

/** A module the section waits for: the download dialog asks, then says how it went. */
export interface ModuleWait {
  module: ModuleSummary;
  done: (installed: boolean) => void;
}

/**
 * Whether a module can run now. When it is missing or outdated, its download dialog asks
 * first (through `wait`); this resolves once it is installed or the person closes the dialog.
 */
export async function waitForModule(
  modules: { ensure: (id: string) => Promise<ModuleNeed> },
  wait: WritableSignal<ModuleWait | undefined>,
  driver: string,
): Promise<boolean> {
  const need = await modules.ensure(driver);
  if (need.ready) return true;
  return new Promise<boolean>((done) =>
    wait.set({
      module: need.module,
      done: (installed) => {
        wait.set(undefined);
        done(installed);
      },
    }),
  );
}
