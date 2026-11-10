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
      z-index: 200;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      width: min(380px, calc(100vw - 40px));
      padding: 12px 10px 12px 14px;
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-left: 4px solid var(--blue);
      border-radius: 8px;
      box-shadow: 0 12px 40px #0008;
    }
    .toast.success {
      border-left-color: var(--green);
    }
    .toast.error {
      border-left-color: var(--red);
    }
    .toast-icon {
      flex: none;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      font-weight: 700;
      font-size: 12px;
      color: #fff;
      background: var(--blue);
    }
    .success .toast-icon {
      background: var(--green);
    }
    .error .toast-icon {
      background: var(--red);
    }
    .toast-text {
      flex: 1;
      min-width: 0;
    }
    .toast-text p {
      margin: 4px 0 0;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .toast-detail {
      font-family: var(--mono);
      font-size: 11px;
    }
  `,
})
export class ToastMessage {
  protected readonly state = inject(WorkspaceState);
}
