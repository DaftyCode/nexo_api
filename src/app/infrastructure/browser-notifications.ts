import { Injectable } from '@angular/core';
import { NotificationPermission, NotificationPort } from '../application/ports';

/**
 * System notifications through the web `Notification` API. In the desktop app the Tauri
 * notification plugin stands behind that same API, so both versions use this adapter.
 */
@Injectable()
export class BrowserNotifications implements NotificationPort {
  private readonly api = typeof Notification === 'undefined' ? undefined : Notification;

  permission(): NotificationPermission {
    return this.api ? this.api.permission : 'unsupported';
  }
  async request(): Promise<NotificationPermission> {
    if (!this.api) return 'unsupported';
    if (this.api.permission !== 'default') return this.api.permission;
    return this.api.requestPermission();
  }
  show(title: string, body: string) {
    if (this.api?.permission === 'granted') new this.api(title, { body });
  }
}
