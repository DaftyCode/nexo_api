import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  model,
  untracked,
  viewChild,
} from '@angular/core';
import { FormValueControl } from '@angular/forms/signals';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  completion,
  graphqlLanguageSupport,
  jump,
  lint,
  stateExtensions,
  updateSchema,
} from 'cm6-graphql';
import { GraphQLSchema as ClientSchema, IntrospectionQuery, buildClientSchema } from 'graphql';
import { GraphQLSchema, completeIntrospection, insertAt } from '../domain/graphql-schema';
import { baseExtensions } from './code-editor-setup';

/** A schema for the editor from the introspection kept with ours; none if it cannot be built. */
export function clientSchema(schema: GraphQLSchema | undefined): ClientSchema | undefined {
  if (!schema?.introspection) return undefined;
  try {
    return buildClientSchema(completeIntrospection(schema.introspection) as IntrospectionQuery);
  } catch {
    return undefined;
  }
}

/**
 * The GraphQL query editor: syntax colours and, with the endpoint's schema loaded, the fields,
 * arguments, variable types and enum values of where the cursor is, and marks on what the
 * schema does not have. Without a schema it is a plain code editor.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-graphql-query-editor',
  template: '<div #host class="graphql-query-editor"></div>',
  styles: `
    :host {
      display: block;
      height: 175px;
      resize: vertical;
      overflow: hidden;
    }
    .graphql-query-editor {
      height: 100%;
    }
  `,
})
export class GraphqlQueryEditor implements FormValueControl<string> {
  readonly value = model('');
  readonly schema = input<GraphQLSchema | undefined>();
  /** The accessible name of the editing area. */
  readonly label = input('');
  readonly placeholder = input('');
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: EditorView | undefined;
  /** Marks unknown fields only with a schema: without one every name would be wrong. */
  private readonly linting = new Compartment();

  constructor() {
    afterNextRender(() => this.create());
    effect(() => {
      const value = this.value();
      untracked(() => {
        const view = this.view;
        if (view && value !== view.state.doc.toString())
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      });
    });
    effect(() => {
      const schema = clientSchema(this.schema());
      untracked(() => {
        if (!this.view) return;
        updateSchema(this.view, schema);
        this.view.dispatch({ effects: this.linting.reconfigure(schema ? lint : []) });
      });
    });
    inject(DestroyRef).onDestroy(() => this.view?.destroy());
  }

  private create() {
    const schema = clientSchema(this.schema());
    this.view = new EditorView({
      parent: this.host().nativeElement,
      state: EditorState.create({
        doc: this.value(),
        extensions: [
          ...baseExtensions({
            label: this.label(),
            placeholder: this.placeholder(),
            changed: (text) => this.value.set(text),
          }),
          graphqlLanguageSupport(),
          completion,
          jump,
          stateExtensions(schema),
          this.linting.of(schema ? lint : []),
        ],
      }),
    });
  }

  /** Inserts a snippet at the cursor, as the schema explorer does, and keeps the focus. */
  insert(snippet: string) {
    const view = this.view;
    if (!view) {
      this.value.set(insertAt(this.value(), this.value().length, snippet).value);
      return;
    }
    const inserted = insertAt(view.state.doc.toString(), view.state.selection.main.head, snippet);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: inserted.value },
      selection: { anchor: inserted.cursor },
    });
    view.focus();
  }
  /** The CodeMirror view, once created; for tests. */
  editor() {
    return this.view;
  }
}
