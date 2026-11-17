import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { placeBy } from '../popup-place';

let pickers = 0;
/** The narrowest the list of types opens. */
const WIDTH = 240;

/**
 * The type of a column, as DBeaver's: a text to write any type (`varchar(100)` too) and a
 * list of every type of the engine, the user's included, opened whole with its button or
 * the down arrow, the current type marked, and narrowed only by what is typed. A WAI-ARIA
 * combobox: arrows move through the list, Enter takes a type, Escape closes it.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-db-type-picker',
  host: { '(document:scroll)': 'close()', '(window:resize)': 'close()' },
  template: `
    <div class="db-type-picker">
      <input
        #field
        role="combobox"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        [attr.aria-label]="label()"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="open() && active() >= 0 ? optionId(active()) : null"
        [value]="text()"
        (input)="typed($event)"
        (keydown)="key($event)"
        (change)="commit()"
        (blur)="close(); commit()"
      />
      <button
        type="button"
        class="db-type-toggle"
        tabindex="-1"
        [attr.aria-label]="'Show the types' | transloco"
        (mousedown)="$event.preventDefault()"
        (click)="toggle()"
      >
        ▾
      </button>
    </div>
    @if (open()) {
      <ul
        class="db-type-list"
        role="listbox"
        [id]="listId"
        [attr.aria-label]="'Types' | transloco"
        [style.left.px]="place().x"
        [style.top.px]="place().y"
        [style.bottom.px]="place().bottom"
        [style.min-width.px]="place().width"
        (mousedown)="$event.preventDefault()"
      >
        @for (type of shown(); track type; let at = $index) {
          <li
            role="option"
            [id]="optionId(at)"
            [attr.aria-selected]="at === active()"
            [class.db-type-active]="at === active()"
            [class.db-type-current]="isCurrent(type)"
            (mousedown)="choose(type)"
          >
            {{ type }}
            @if (isCurrent(type)) {
              <span aria-hidden="true">✓</span>
            }
          </li>
        } @empty {
          <li class="db-type-none" role="option" aria-disabled="true" aria-selected="false">
            {{ 'No type matches' | transloco }}
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .db-type-picker {
      display: flex;
      align-items: stretch;
    }
    .db-type-picker input {
      flex: 1;
      min-width: 0;
    }
    .db-type-toggle {
      padding: 0 var(--nexo-space-4);
      border: none;
      background: transparent;
      color: var(--nexo-color-text-muted);
      cursor: pointer;
    }
    .db-type-list {
      position: fixed;
      z-index: var(--nexo-z-popover);
      max-height: 280px;
      overflow: auto;
      margin: 0;
      padding: var(--nexo-space-2);
      list-style: none;
      border: var(--nexo-border-width) solid var(--nexo-color-border-strong);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-surface);
      box-shadow: var(--nexo-shadow-lg);
      font-family: var(--nexo-font-mono);
      font-size: var(--nexo-font-size-sm);
    }
    .db-type-list li {
      padding: var(--nexo-space-2) var(--nexo-space-4);
      border-radius: var(--nexo-radius-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    .db-type-list li:hover,
    .db-type-active {
      background: var(--nexo-color-selection);
    }
    .db-type-current {
      font-weight: var(--nexo-font-weight-bold);
    }
    .db-type-list .db-type-none {
      color: var(--nexo-color-text-muted);
      cursor: default;
    }
  `,
})
export class DbTypePicker {
  /** The type the column has. */
  readonly value = input.required<string>();
  /** Every type of the engine. */
  readonly types = input.required<readonly string[]>();
  readonly label = input.required<string>();
  /** A type chosen or written, once it is not the one the column had. */
  readonly changed = output<string>();
  protected readonly listId = `db-types-${++pickers}`;
  protected readonly text = linkedSignal(() => this.value());
  /** The type last given out: the column's, until another one is chosen. */
  private readonly committed = linkedSignal(() => this.value());
  protected readonly open = signal(false);
  /** What narrows the list: nothing when it was opened whole. */
  protected readonly filter = signal('');
  protected readonly active = signal(-1);
  protected readonly place = signal<{ x: number; y?: number; bottom?: number; width: number }>({
    x: 0,
    width: WIDTH,
  });
  protected readonly shown = computed(() => {
    const wanted = this.filter().trim().toLowerCase();
    const types = this.types();
    return wanted ? types.filter((type) => type.toLowerCase().includes(wanted)) : types;
  });
  /** The current type without its length: `character varying(255)` is `character varying`. */
  private readonly base = computed(() =>
    this.text()
      .replace(/\s*\(.*$/, '')
      .trim()
      .toLowerCase(),
  );
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly injector = inject(Injector);

  protected optionId(at: number) {
    return `${this.listId}-${at}`;
  }
  protected isCurrent(type: string) {
    return type.toLowerCase() === this.base();
  }

  /** Opens the whole list, at the current type. */
  private show(filter = '') {
    const element = this.field().nativeElement;
    const width = Math.max(WIDTH, element.getBoundingClientRect().width);
    this.place.set({ ...placeBy(element, width), width });
    this.filter.set(filter);
    const shown = this.shown();
    const current = shown.findIndex((type) => this.isCurrent(type));
    this.active.set(filter ? (shown.length ? 0 : -1) : current);
    this.open.set(true);
    this.reveal();
  }
  /** Scrolls the list to the option the arrows are on. */
  private reveal() {
    afterNextRender(
      () =>
        globalThis.document
          ?.getElementById(this.optionId(this.active()))
          ?.scrollIntoView?.({ block: 'nearest' }),
      { injector: this.injector },
    );
  }
  close() {
    this.open.set(false);
  }

  protected toggle() {
    if (this.open()) return this.close();
    this.field().nativeElement.focus();
    this.show();
  }
  protected typed(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    this.show(value);
  }
  protected choose(type: string) {
    this.text.set(type);
    this.close();
    this.commit();
  }
  protected commit() {
    const value = this.text().trim();
    if (!value || value === this.committed()) return;
    this.committed.set(value);
    this.changed.emit(value);
  }

  protected key(event: KeyboardEvent) {
    const shown = this.shown();
    const move = (to: number) => {
      event.preventDefault();
      this.active.set(Math.max(0, Math.min(shown.length - 1, to)));
      this.reveal();
    };
    switch (event.key) {
      case 'ArrowDown':
        if (!this.open()) {
          event.preventDefault();
          return this.show();
        }
        return move(this.active() + 1);
      case 'ArrowUp':
        return this.open() ? move(this.active() - 1) : undefined;
      case 'Home':
        return this.open() ? move(0) : undefined;
      case 'End':
        return this.open() ? move(shown.length - 1) : undefined;
      case 'Enter':
        event.preventDefault();
        if (this.open() && shown[this.active()]) return this.choose(shown[this.active()]);
        this.close();
        return this.commit();
      case 'Escape':
        if (!this.open()) return;
        event.preventDefault();
        event.stopPropagation();
        return this.close();
    }
  }
}
