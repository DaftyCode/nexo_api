import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { ExecutionResponse } from '../domain/models';
import { schemaTest, withSchemaTest } from '../domain/schema-test';
import { InferredSchema } from '../application/workspace-use-cases/schema';
import { WorkspaceState, success } from './workspace-state';

const SCHEMA_TYPE = 'application/schema+json';

/**
 * «JSON Schema…» of a JSON response: the schema read from it and from the responses the
 * history keeps of the same request (fields all of them have are required), to add as a
 * test of the request or to download.
 */
@Component({
  imports: [TranslocoPipe, FormField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-response-schema',
  styles: `
    .response-schema {
      display: grid;
      gap: var(--nexo-space-3);
    }
    pre {
      max-height: calc(var(--nexo-size-unit) * 80);
      overflow: auto;
      margin: 0;
      font-family: var(--nexo-font-mono);
    }
  `,
  template: `
    @if (open()) {
      <section class="response-schema card" [attr.aria-label]="'JSON Schema' | transloco">
        <label class="check-field"
          ><input type="checkbox" [formField]="fields.enums" />{{
            'Short enums: strings with a few values that repeat' | transloco
          }}</label
        >
        <div class="button-grid">
          <button type="button" class="button primary" (click)="infer()">
            {{ 'Infer schema' | transloco }}
          </button>
          <button type="button" class="button" (click)="close()">
            {{ 'Close' | transloco }}
          </button>
        </div>
        @if (inferred(); as found) {
          <p class="muted">{{ 'schema.sampled' | transloco: { v0: found.sampled } }}</p>
          <pre tabindex="0" [attr.aria-label]="'JSON Schema' | transloco">{{ text() }}</pre>
          <div class="button-grid">
            <button type="button" class="button primary" (click)="addTest()">
              {{ 'Add schema test' | transloco }}
            </button>
            <button type="button" class="button" (click)="download()">
              {{ 'Download schema' | transloco }}
            </button>
          </div>
        }
      </section>
    } @else {
      <button type="button" class="button" (click)="open.set(true)">
        {{ 'JSON Schema…' | transloco }}
      </button>
    }
  `,
})
export class ResponseSchema {
  readonly response = input.required<ExecutionResponse>();
  private readonly state = inject(WorkspaceState);
  protected readonly open = signal(false);
  protected readonly model = signal({ enums: false });
  protected readonly fields = form(this.model);
  protected readonly inferred = signal<InferredSchema | undefined>(undefined);
  protected readonly text = computed(() => JSON.stringify(this.inferred()?.schema ?? {}, null, 2));

  /** The name the history gives the request of the active tab. */
  private name() {
    const request = this.state.active()?.request;
    return request ? `${request.method} ${request.url}` : '';
  }

  protected infer() {
    void this.state.announce('The schema could not be inferred', async () => {
      this.inferred.set(
        await this.state.cases.schemas.infer(
          this.state.workspaceId(),
          this.response(),
          this.state.history(),
          this.name(),
          this.model().enums,
        ),
      );
      return undefined;
    });
  }

  protected close() {
    this.open.set(false);
    this.inferred.set(undefined);
  }

  /** Adds the test to the request of the active tab, in place of the one added before. */
  protected addTest() {
    void this.state.announce('The schema test could not be added', async () => {
      const tab = this.state.active();
      const found = this.inferred();
      if (!tab || !found) throw new Error('Open a request first');
      this.state.edit({
        ...tab.request,
        tests: withSchemaTest(tab.request.tests, schemaTest(found.schema, found.sampled)),
      });
      return success('Schema test added', 'toast.schemaTestAdded');
    });
  }

  protected download() {
    void this.state.download(
      'response.schema.json',
      () => new Blob([this.text()], { type: SCHEMA_TYPE }),
      SCHEMA_TYPE,
    );
  }
}
