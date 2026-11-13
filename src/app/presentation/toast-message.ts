import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WorkspaceState } from './workspace-state';

/**
 * A short message in a corner of the workspace: what went well, wrong or was cancelled. It
 * closes by itself after 20 seconds, or with its button. Errors are announced at once,
 * the rest politely.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-toast-message',
  template: `
    @if (state.toast(); as toast) {
      <div
        class="toast"
        [class]="'toast ' + toast.kind"
        [attr.role]="toast.kind === 'error' ? 'alert' : 'status'"
        [attr.aria-live]="toast.kind === 'error' ? 'assertive' : 'polite'"
      >
        <span class="toast-icon" aria-hidden="true">{{
          toast.kind === 'success' ? '✓' : toast.kind === 'error' ? '!' : 'i'
        }}</span>
        <div class="toast-text">
          <strong>{{ toast.title | transloco }}</strong>
          @if (toast.message) {
            <p>{{ toast.message | transloco: toast.params ?? {} }}</p>
          }
          @if (toast.detail) {
            <p class="toast-detail">{{ toast.detail | transloco }}</p>
          }
        </div>
        <button
          type="button"
          class="icon-button"
          (click)="state.closeToast()"
          [attr.aria-label]="'Close notification' | transloco"
        >
          ×
        </button>
      </div>
    }
  `,
  styles: `
    .toast {
      position: fixed;
      right: 20px;
      bottom: 44px;
      z-index: var(--nexo-z-toast);
      display: flex;
      align-items: flex-start;
      gap: var(--nexo-space-5);
      width: min(380px, calc(100vw - 40px));
      padding: var(--nexo-space-6) var(--nexo-space-5) var(--nexo-space-6) var(--nexo-space-7);
      background: var(--nexo-color-surface);
      color: var(--nexo-color-text);
      border: var(--nexo-border-width) solid var(--nexo-color-border);
      border-left: var(--nexo-border-width-accent) solid var(--nexo-color-info);
      border-radius: var(--nexo-radius-lg);
      box-shadow: var(--nexo-shadow-lg);
    }
    .toast.success {
      border-left-color: var(--nexo-color-success);
    }
    .toast.error {
      border-left-color: var(--nexo-color-danger);
    }
    .toast-icon {
      flex: none;
      display: grid;
      place-items: center;
      width: var(--nexo-size-11);
      height: var(--nexo-size-11);
      border-radius: 50%;
      font-weight: var(--nexo-font-weight-bold);
      font-size: var(--nexo-font-size-sm);
      color: var(--nexo-color-on-status);
      background: var(--nexo-color-info);
    }
    .success .toast-icon {
      background: var(--nexo-color-success);
    }
    .error .toast-icon {
      background: var(--nexo-color-danger);
    }
    .toast-text {
      flex: 1;
      min-width: 0;
    }
    .toast-text p {
      margin: var(--nexo-space-2) 0 0;
      color: var(--nexo-color-text-muted);
      overflow-wrap: anywhere;
    }
    .toast-detail {
      font-family: var(--nexo-font-mono);
      font-size: var(--nexo-font-size-xs);
    }
  `,
})
export class ToastMessage {
  protected readonly state = inject(WorkspaceState);
}
