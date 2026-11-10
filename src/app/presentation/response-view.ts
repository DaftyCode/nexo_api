import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
  computed,
  inject,
} from '@angular/core';
import { JsonPipe } from '@angular/common';
import { ExecutionResponse, formatJson } from '../domain/models';
import { blockedSecret } from '../domain/secrets';
import { StudioIcon } from './studio-icon';
import { WORKSPACE } from '../composition/providers';

/** Bodies above this size are shown as received; formatting them would block the interface. */
const FORMAT_LIMIT = 2 * 1024 * 1024;
/** Characters rendered before "Show full response"; larger bodies slow the page down. */
const DISPLAY_LIMIT = 512 * 1024;

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
  /** Asks for a printable report of the request and this response. */
  readonly exportPdf = output<void>();
  protected readonly tab = signal('body');
  protected readonly blocked = blockedSecret;
  protected readonly pretty = signal(true);
  private readonly cases = inject(WORKSPACE);
  protected readonly binary = computed(() => this.response()?.bodyEncoding === 'base64');
  protected readonly contentType = computed(
    () =>
      this.response()
        ?.headers?.find((h) => h.key.toLowerCase() === 'content-type')
        ?.value.split(';')[0]
        .trim() ?? 'application/octet-stream',
  );
  protected readonly imageUrl = computed(() =>
    this.binary() && /^image\/(png|jpe?g|gif|webp)$/.test(this.contentType())
      ? `data:${this.contentType()};base64,${this.response()?.body ?? ''}`
      : '',
  );
  protected readonly large = computed(() => (this.response()?.body ?? '').length > FORMAT_LIMIT);
  /** The response whose full body the user chose to show. */
  private readonly expanded = signal<ExecutionResponse | undefined>(undefined);
  private readonly formatted = computed(() => {
    const body = this.response()?.body ?? '';
    if (this.binary()) return '';
    return this.pretty() && !this.large() ? formatJson(body) : body;
  });
  protected readonly truncated = computed(
    () => this.formatted().length > DISPLAY_LIMIT && this.expanded() !== this.response(),
  );
  protected readonly text = computed(() =>
    this.truncated() ? this.formatted().slice(0, DISPLAY_LIMIT) : this.formatted(),
  );
  protected showAll() {
    this.expanded.set(this.response());
  }
  protected download() {
    const response = this.response();
    if (!response) return;
    const type = this.contentType();
    const extension = type.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'bin';
    const content = this.binary()
      ? new Blob([Uint8Array.from(atob(response.body), (c) => c.charCodeAt(0))], { type })
      : new Blob([response.body], { type });
    this.cases.files.download(`response.${extension}`, content, type);
  }
  protected readonly passed = computed(
    () => this.response()?.assertions?.filter((x) => x.passed).length ?? 0,
  );
}
