import { Injectable } from '@angular/core';
import { SignInWindowOutcome, SignInWindowPort } from '../application/ports';

/** The desktop app's OAuth 2.0 sign-in window (`oauth2_sign_in_window` in `src-tauri`). */
@Injectable()
export class DesktopSignInWindow implements SignInWindowPort {
  readonly available = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  async open(url: string, callbackUrl: string): Promise<SignInWindowOutcome> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<SignInWindowOutcome>('oauth2_sign_in_window', { url, callback: callbackUrl });
  }
  async close() {
    if (!this.available) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('oauth2_sign_in_window_close');
  }
}
