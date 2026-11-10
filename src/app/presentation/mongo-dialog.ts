import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  Injector,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { CodeEditor } from './code-editor';
import { CollectionForm, emptyCollectionForm } from '../domain/mongo-write';

/** A text field of a dialog. */
export interface DialogField {
  label: string;
  value: string;
}

/** What a dialog asks. Texts are message keys. */
export interface DialogRequest {
  title: string;
  message?: { key: string; params?: Record<string, unknown> };
  /** A code editor, for documents and updates. */
  editor?: DialogField;
  first?: DialogField;
  second?: DialogField;
  /** Options of a new collection. */
  collectionOptions?: boolean;
  /** A name the person must type to confirm. */
  confirmName?: string;
  confirm: string;
  danger?: boolean;
}

/** What the person answered. */
export interface DialogAnswer {
  text: string;
  first: string;
  second: string;
  options: CollectionForm;
}

interface DialogModel extends CollectionForm {
  text: string;
  first: string;
  second: string;
  typed: string;
}

/**
 * The dialog of a MongoDB write: what will happen, and the document, update or names it
 * needs. Destructive writes ask for a name to be typed before they can be confirmed.
 */
@Component({
  imports: [TranslocoPipe, FormField, CodeEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-dialog',
  styleUrl: './mongo-dialog.scss',
  templateUrl: './mongo-dialog.html',
  host: { '(keydown.escape)': 'cancelled.emit()' },
})
export class MongoDialog {
  readonly request = input.required<DialogRequest>();
  /** Why the last answer could not be written, as a message key with its values. */
  readonly problem = input<{ key: string; params?: Record<string, unknown> } | undefined>();
  readonly busy = input(false);
  readonly confirmed = output<DialogAnswer>();
  readonly cancelled = output<void>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly model = signal<DialogModel>(this.empty());
  protected readonly fields = form(this.model);
  protected readonly granularities = ['', 'seconds', 'minutes', 'hours'];
  protected readonly ready = computed(() => {
    const name = this.request().confirmName;
    return !name || this.model().typed.trim() === name;
  });

  constructor() {
    effect(() => {
      const request = this.request();
      untracked(() => {
        this.model.set({
          ...this.empty(),
          text: request.editor?.value ?? '',
          first: request.first?.value ?? '',
          second: request.second?.value ?? '',
        });
        // The first control, for the keyboard.
        afterNextRender(
          () =>
            this.host.nativeElement
              .querySelector<HTMLElement>('input, .cm-content, button.primary, button.danger')
              ?.focus(),
          { injector: this.injector },
        );
      });
    });
  }

  private empty(): DialogModel {
    return { ...emptyCollectionForm(), text: '', first: '', second: '', typed: '' };
  }

  protected submit() {
    if (!this.ready() || this.busy()) return;
    const { text, first, second, typed: _, ...options } = this.model();
    this.confirmed.emit({ text, first, second, options });
  }
}
