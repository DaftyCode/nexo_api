import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const paths: Record<string, string> = {
  collections: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  environments: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  history: 'M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 4v5l4 2',
  runner: 'm7 3 14 9L7 21V3Z',
  realtime: 'M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4',
  mocks: 'm12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9v10M3 8l9 4 9-4',
  datasets: 'M5 3h14v18H5V3Zm0 6h14M5 15h14M10 3v18M15 3v18',
  databases:
    'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  mongo: 'M12 2c4 4 5 8 5 11a5 5 0 0 1-10 0c0-3 1-7 5-11Zm0 0v20',
  git: 'M6 3v12a4 4 0 0 0 4 4h3m-7-4 0 0m12-12v5a4 4 0 0 1-4 4H6M3 3a3 3 0 1 0 6 0M15 3a3 3 0 1 0 6 0M13 19a3 3 0 1 0 6 0',
  mcp: 'M9 7H6a3 3 0 1 1 3-3v16a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V4a3 3 0 1 1 3 3H9',
  settings:
    'm10 3-1 3-3 1-3 3 2 3v4l3 1 2 3h4l2-3 3-1v-4l2-3-3-3-3-1-1-3h-4Zm2 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  params: 'M3 7h18M3 17h18M8 4v6M16 14v6',
  authorization: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm0 5v5m0 3v1',
  headers: 'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  body: 'M8 3H6v7l-3 2 3 2v7h2M16 3h2v7l3 2-3 2v7h-2',
  scripts: 'm8 4 12 8-12 8V4Z',
  cookies: 'M21 12a9 9 0 1 1-9-9 5 5 0 0 0 9 9ZM8 9h.01M7 15h.01M13 17h.01M13 10h.01',
  tests: 'M9 4h6v3H9V4ZM7 6H5v15h14V6h-2M8 13l2 2 5-5',
  console: 'm4 6 5 6-5 6M12 18h8',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v7h10V3M7 21v-7h10v7',
  code: 'm7 6-5 6 5 6m10-12 5 6-5 6M14 3l-4 18',
  send: 'm3 10 18-7-7 18-3-8-8-3Zm8 3L21 3',
  chevron: 'm9 6 6 6-6 6',
  // Objects of the database navigator.
  table: 'M4 5h16v14H4V5Zm0 5h16M4 14.5h16M10 10v9',
  view: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  column: 'M9 4h6v16H9V4Zm0 5h6',
  schema: 'M4 5h7v6H4V5Zm9 8h7v6h-7v-6ZM7.5 11v5H13',
  key: 'M8 14a4 4 0 1 1 3.5-6H21v3h-2v2h-3v-2h-4.5A4 4 0 0 1 8 14Z',
  function: 'M15 4h-2a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H5m3-10h7',
  sequence: 'M4 7h3v10M10 9a2 2 0 1 1 4 0c0 2-4 4-4 8h4M17 7h3l-2 4a3 3 0 1 1-2 5',
  index: 'M5 4v16M5 8h10M5 13h14M5 18h7',
  trigger: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  role: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM4 21a8 8 0 0 1 16 0',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
};

@Component({
  selector: 'app-studio-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      [attr.d]="path()"
      stroke="currentColor"
      stroke-width="1.65"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>`,
  styles: `
    :host {
      display: inline-flex;
      width: var(--nexo-size-10);
      height: var(--nexo-size-10);
      flex-shrink: 0;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class StudioIcon {
  readonly name = input.required<string>();
  protected readonly path = computed(() => paths[this.name()] ?? paths['collections']);
}
