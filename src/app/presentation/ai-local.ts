import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { AI, NATIVE_FILES } from '../composition/providers';
import { LocalAiStatus, MODEL_SIZES, byteSize, localReady } from '../domain/ai';
import { WorkspaceState, success } from './workspace-state';

/** How often an installation is asked how it goes. */
const POLL = 1000;

/**
 * The model run inside Nexo (IA-01): one button downloads llama.cpp for the computer's GPU
 * and the Qwen3.5 model that fits its memory, with their sizes said before; then what was
 * chosen and why, and the way to delete it or to use a GGUF file of one's own.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-local',
  templateUrl: './ai-local.html',
})
export class AiLocal {
  private readonly ai = inject(AI);
  private readonly files = inject(NATIVE_FILES, { optional: true });
  protected readonly state = inject(WorkspaceState);
  /** The model became ready, or stopped being. */
  readonly changed = output<boolean>();
  protected readonly status = signal<LocalAiStatus | undefined>(undefined);
  protected readonly error = signal('');
  protected readonly own = signal({ path: '' });
  protected readonly ownFields = form(this.own);
  protected readonly dialog = !!this.files?.available;
  protected readonly size = byteSize;
  protected readonly sizes = MODEL_SIZES;
  protected readonly ready = computed(() => localReady(this.status()));
  protected readonly device = computed(() => {
    const status = this.status();
    return status?.devices.find((device) => device.id === status.device);
  });
  private timer?: ReturnType<typeof setTimeout>;
  private gone = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.gone = true;
      clearTimeout(this.timer);
    });
    void this.load();
  }

  private show(status: LocalAiStatus) {
    const wasReady = this.ready();
    this.status.set(status);
    if (this.ready() !== wasReady) this.changed.emit(this.ready());
    clearTimeout(this.timer);
    if (status.installing && !this.gone) this.timer = setTimeout(() => void this.load(), POLL);
  }

  private async run(action: () => Promise<LocalAiStatus>) {
    try {
      this.error.set('');
      this.show(await action());
    } catch (error) {
      this.error.set(this.state.describe(error));
    }
  }

  protected load() {
    return this.run(() => this.ai.localStatus());
  }
  protected install() {
    return this.run(() => this.ai.installLocal());
  }
  protected async chooseFile() {
    const path = this.dialog ? await this.files?.choose('open') : this.own().path.trim();
    if (!path) return;
    await this.run(() => this.ai.useLocalFile(path));
  }
  protected async remove() {
    if (!this.state.confirm('Delete the local model and its engine from this computer?')) return;
    await this.run(() => this.ai.removeLocal());
    if (!this.error()) this.state.tell(success('Local model deleted', 'ai.local.deleted'));
  }
}
