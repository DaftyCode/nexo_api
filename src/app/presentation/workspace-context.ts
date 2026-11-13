import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { asCollection, items, WorkspaceDocument } from '../domain/models';
import { WorkspaceState } from './workspace-state';
import { StudioIcon } from './studio-icon';
import { LanguageState } from './language-state';

export function environmentPreview(
  value: unknown,
): { key: string; text: string; secret: boolean }[] {
  const rows = (value as { values?: unknown[] } | undefined)?.values;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row['key'] !== 'string' ||
      !row['key'] ||
      row['enabled'] === false ||
      row['disabled'] === true
    )
      return [];
    const text = String(row['value'] ?? '');
    const secret =
      row['type'] === 'secret' ||
      row['sensitive'] === true ||
      /password|secret|token|api.?key|authorization|credential|private.?key/i.test(row['key']) ||
      text.includes('{{vault:');
    return [{ key: row['key'], text: secret ? '••••••••' : text, secret }];
  });
}

@Component({
  selector: 'app-workspace-context',
  imports: [TranslocoPipe, StudioIcon, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (layout() === 'strip') {
      <section class="recent-strip" [attr.aria-label]="'Recent requests' | transloco">
        <strong>{{ 'Recent' | transloco }}</strong>
        @for (entry of recent(); track entry.document.id) {
          <button (click)="state.openHistory(entry.document)">
            <span class="method-tag" [attr.data-method]="entry.method">{{ entry.method }}</span
            ><span>{{ entry.document.name }}</span>
          </button>
        } @empty {
          <span class="context-empty">{{
            'Send a request to start your history.' | transloco
          }}</span>
        }
        <button class="recent-view-all" (click)="state.section.set('history')">
          {{ 'View all →' | transloco }}
        </button>
      </section>
    } @else {
      <aside class="context-panel" [attr.aria-label]="'Workspace context' | transloco">
        <section class="context-card">
          <h2><app-studio-icon name="environments" />{{ 'Environment' | transloco }}</h2>
          <div class="context-environment">
            <span class="connection-dot"></span>
            <select
              (change)="selectEnvironment($event)"
              [attr.aria-label]="'Context environment' | transloco"
            >
              <option value="" [selected]="!state.environmentId()">
                {{ 'No environment' | transloco }}
              </option>
              @for (environment of state.environments(); track environment.id) {
                <option
                  [value]="environment.id"
                  [selected]="environment.id === state.environmentId()"
                >
                  {{ environment.name }}
                </option>
              }
            </select>
            <button
              class="icon-button"
              [attr.aria-label]="'Manage environments' | transloco"
              [title]="'Manage environments' | transloco"
              (click)="state.section.set('environments')"
            >
              <app-studio-icon name="settings" />
            </button>
          </div>
        </section>
        <section class="context-card">
          <h2><app-studio-icon name="collections" />{{ 'Current collection' | transloco }}</h2>
          @if (collection(); as current) {
            <strong class="context-collection-name">{{ current.name }}</strong>
            <div class="row between">
              <span class="muted">{{ 'counts.requests' | transloco: { v0: requestCount() } }}</span
              ><button
                class="icon-button"
                [title]="'Open runner' | transloco"
                [attr.aria-label]="'Open runner' | transloco"
                (click)="state.section.set('runner')"
              >
                <app-studio-icon name="runner" />
              </button>
            </div>
          } @else {
            <p class="context-empty">
              {{ 'Open a saved request to see its collection.' | transloco }}
            </p>
          }
        </section>
        <section class="context-card">
          <div class="context-heading">
            <h2><app-studio-icon name="history" />{{ 'Recent history' | transloco }}</h2>
            <button class="text-button" (click)="state.section.set('history')">
              {{ 'View all' | transloco }}
            </button>
          </div>
          @for (entry of recent(); track entry.document.id) {
            <button class="context-history-row" (click)="state.openHistory(entry.document)">
              <span class="method-tag" [attr.data-method]="entry.method">{{ entry.method }}</span>
              <span class="context-history-name">{{ entry.document.name }}</span>
              @if (entry.status) {
                <span class="context-status" [class.danger]="entry.status >= 400">{{
                  entry.status
                }}</span>
              }
              <small>{{
                entry.document.updated_at * 1000
                  | date: 'shortTime' : undefined : language.model().language
              }}</small>
            </button>
          } @empty {
            <p class="context-empty">{{ 'Your sent requests will appear here.' | transloco }}</p>
          }
        </section>
        <section class="context-card">
          <h2><app-studio-icon name="body" />{{ 'Environment variables' | transloco }}</h2>
          @if (variables().length) {
            <div class="context-variable-list">
              @for (variable of variables(); track $index) {
                <div class="context-variable">
                  <span>{{ variable.key }}</span
                  ><code
                    [class.masked]="variable.secret"
                    [attr.title]="
                      variable.secret ? ('Sensitive value hidden' | transloco) : variable.text
                    "
                    >{{ variable.text }}</code
                  >
                </div>
              }
            </div>
            <p class="context-privacy">{{ 'Sensitive values are hidden.' | transloco }}</p>
          } @else {
            <p class="context-empty">{{ 'Select an environment with variables.' | transloco }}</p>
          }
        </section>
        <a class="context-card context-docs" href="/docs"
          ><h2><app-studio-icon name="headers" />{{ 'Documentation' | transloco }}</h2>
          <span
            >{{ "Explore Nexo's features" | transloco }} <span aria-hidden="true">↗</span></span
          ></a
        >
      </aside>
    }
  `,
  styleUrl: './workspace-context.scss',
})
export class WorkspaceContext {
  readonly layout = input<'sidebar' | 'strip'>('sidebar');
  protected readonly state = inject(WorkspaceState);
  protected readonly language = inject(LanguageState);
  protected selectEnvironment(event: Event) {
    this.state.selectEnvironment((event.target as HTMLSelectElement).value);
  }
  protected readonly collection = computed(() => {
    const id = this.state.active()?.documentId;
    return this.state.collections().find((collection) => collection.id === id);
  });
  protected readonly requestCount = computed(() => {
    const collection = this.collection();
    return collection
      ? items(asCollection(collection.value)).filter((entry) => entry.item.request).length
      : 0;
  });
  protected readonly variables = computed(() =>
    environmentPreview(
      this.state.environments().find((environment) => environment.id === this.state.environmentId())
        ?.value,
    ),
  );
  protected readonly recent = computed(() =>
    this.state
      .history()
      .slice()
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 4)
      .map((document: WorkspaceDocument) => {
        const value = document.value as {
          request?: { method?: string };
          response?: { status?: number };
        };
        return {
          document,
          // History is listed without values; its name starts with the method.
          method: value?.request?.method ?? (document.name.split(' ')[0] || 'HTTP'),
          status: value?.response?.status,
        };
      }),
  );
}
