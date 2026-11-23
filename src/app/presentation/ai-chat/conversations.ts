import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { StudioIcon } from '../studio-icon';

/** A conversation kept in the workspace, as the list shows it. */
export interface ConversationEntry {
  id: string;
  title: string;
  revision: number;
}

/**
 * The conversations of the chat: a button with the one on screen opens the list of those kept,
 * where a row opens its conversation and its bin deletes it (the chat asks first); New starts
 * another one. Escape or a click elsewhere closes the list.
 */
@Component({
  imports: [TranslocoPipe, StudioIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-conversations',
  host: {
    '(document:click)': 'outside($event)',
    '(keydown.escape)': 'shown.set(false)',
  },
  template: `
    <div class="field">
      <span>{{ 'Conversation' | transloco }}</span>
      <div class="row">
        <div class="pick">
          <button
            type="button"
            class="toggle"
            aria-haspopup="true"
            [attr.aria-expanded]="shown()"
            [attr.aria-label]="'Conversation' | transloco"
            [disabled]="busy()"
            (click)="shown.set(!shown())"
          >
            <span class="title">{{ title() || ('New conversation' | transloco) }}</span>
            <span aria-hidden="true">▾</span>
          </button>
          @if (shown()) {
            <ul class="list" [attr.aria-label]="'Conversations' | transloco">
              @for (entry of list(); track entry.id) {
                <li [class.current]="entry.id === current()">
                  <button type="button" class="open" (click)="choose(entry.id)">
                    {{ entry.title }}
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    [attr.aria-label]="'ai.conversation.delete' | transloco: { v0: entry.title }"
                    [attr.title]="'ai.conversation.delete' | transloco: { v0: entry.title }"
                    (click)="removed.emit(entry)"
                  >
                    <app-studio-icon name="trash" />
                  </button>
                </li>
              } @empty {
                <li class="muted none">{{ 'No conversations yet' | transloco }}</li>
              }
            </ul>
          }
        </div>
        <button type="button" class="button" [disabled]="busy()" (click)="started.emit()">
          {{ 'New' | transloco }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .row {
      gap: var(--nexo-space-3);
    }
    .pick {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: var(--nexo-space-3);
      width: 100%;
      min-height: var(--nexo-size-16);
      padding: var(--nexo-space-3) var(--nexo-space-5);
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-surface);
      color: var(--nexo-color-text);
      font: inherit;
      font-size: var(--nexo-font-size-sm);
      text-align: start;
    }
    .title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list {
      position: absolute;
      inset-inline: 0;
      top: calc(100% + var(--nexo-space-1));
      z-index: var(--nexo-z-popover);
      max-height: calc(var(--nexo-size-unit) * 90);
      margin: 0;
      padding: var(--nexo-space-1);
      overflow: auto;
      list-style: none;
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-radius: var(--nexo-radius-md);
      background: var(--nexo-color-surface);
      box-shadow: var(--nexo-shadow-lg);
    }
    li {
      display: flex;
      align-items: center;
      border-radius: var(--nexo-radius-sm);
    }
    li:hover,
    li.current {
      background: var(--nexo-color-accent-soft);
    }
    .open {
      flex: 1;
      min-width: 0;
      padding: var(--nexo-space-3) var(--nexo-space-4);
      overflow: hidden;
      border: 0;
      background: none;
      color: var(--nexo-color-text);
      font: inherit;
      font-size: var(--nexo-font-size-sm);
      text-align: start;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .none {
      padding: var(--nexo-space-3) var(--nexo-space-4);
    }
    /* As tall as the button beside it. */
    .button {
      align-self: stretch;
    }
  `,
})
export class AiConversations {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly list = input<readonly ConversationEntry[]>([]);
  /** The conversation on screen, when it is kept. */
  readonly current = input<string | undefined>(undefined);
  /** An answer is being written: nothing changes until it ends. */
  readonly busy = input(false);
  readonly opened = output<string>();
  readonly started = output<void>();
  readonly removed = output<ConversationEntry>();
  protected readonly shown = signal(false);
  protected readonly title = computed(
    () => this.list().find((entry) => entry.id === this.current())?.title,
  );

  protected choose(id: string) {
    this.shown.set(false);
    this.opened.emit(id);
  }

  protected outside(event: Event) {
    if (!this.host.contains(event.target as Node)) this.shown.set(false);
  }
}
