import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormField, form } from '@angular/forms/signals';
import { By } from '@angular/platform-browser';
import { acceptCompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { diagnosticCount, forceLinting } from '@codemirror/lint';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { vi } from 'vitest';
import { GraphQLSchema, readSchema } from '../domain/graphql-schema';
import { introspection } from '../testing/graphql';
import { GraphqlQueryEditor, clientSchema } from './graphql-query-editor';

/** The schema of a server, as an introspection would load it. */
const shop = readSchema(
  JSON.stringify({
    data: introspectionFromSchema(
      buildSchema(`
        """Entry points"""
        type Query {
          """A user by ID"""
          user(id: ID!): User
          orders(status: Status): [Order!]!
        }
        type User { id: ID! name: String }
        type Order { id: ID! status: Status }
        enum Status { OPEN CLOSED }
      `),
    ),
  }),
);

@Component({
  imports: [GraphqlQueryEditor, FormField],
  template: `<app-graphql-query-editor
    [formField]="fields.query"
    [schema]="schema()"
    label="GraphQL query"
    placeholder="query { … }"
  />`,
})
class Host {
  readonly model = signal({ query: '' });
  readonly fields = form(this.model);
  readonly schema = signal<GraphQLSchema | undefined>(undefined);
}

describe('GraphqlQueryEditor', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let editor: GraphqlQueryEditor;
  const view = () => editor.editor()!;
  const type = (text: string, at = view().state.doc.length) => {
    view().dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
    });
  };
  const suggestions = async () => {
    startCompletion(view());
    await vi.waitFor(() => expect(currentCompletions(view().state).length).toBeGreaterThan(0));
    return currentCompletions(view().state);
  };

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
    editor = fixture.debugElement.query(By.directive(GraphqlQueryEditor)).componentInstance;
  });

  it('is named, keeps the form value in sync both ways and inserts at the cursor', async () => {
    const content = (fixture.nativeElement as HTMLElement).querySelector('.cm-content')!;
    expect(content.getAttribute('aria-label')).toBe('GraphQL query');
    expect(content.getAttribute('contenteditable')).toBe('true');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('query { … }');

    type('query { }');
    await fixture.whenStable();
    expect(host.model().query).toBe('query { }');
    host.model.set({ query: 'query {\n  \n}' });
    await fixture.whenStable();
    expect(view().state.doc.toString()).toBe('query {\n  \n}');

    view().dispatch({ selection: { anchor: 10 } });
    editor.insert('user { id }');
    await fixture.whenStable();
    expect(host.model().query).toBe('query {\n  user { id }\n}');
  });

  it('suggests the fields, arguments and enum values of the schema, with their types', async () => {
    host.schema.set(shop);
    await fixture.whenStable();
    type('query {\n  u');
    const fields = await suggestions();
    const user = fields.find((option) => option.label === 'user')!;
    expect(user.detail).toBe('User');
    const info = typeof user.info === 'function' ? await user.info(user) : undefined;
    expect((info as HTMLElement | undefined)?.textContent).toBe('A user by ID');
    // A suggestion is accepted only after a short delay, so a fast Enter is not taken.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(acceptCompletion(view())).toBe(true);
    await fixture.whenStable();
    expect(host.model().query).toBe('query {\n  user');

    type('(');
    const args = await suggestions();
    expect(args.map((option) => option.label)).toContain('id');

    host.model.set({ query: '' });
    await fixture.whenStable();
    type('query { orders(status: ');
    const values = await suggestions();
    expect(values.map((option) => option.label)).toEqual(
      expect.arrayContaining(['OPEN', 'CLOSED']),
    );
  });

  it('marks what the schema does not have, and nothing without a schema', async () => {
    type('query { user(id: "1") { nickname } }');
    forceLinting(view());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(diagnosticCount(view().state)).toBe(0);

    host.schema.set(shop);
    await fixture.whenStable();
    forceLinting(view());
    await vi.waitFor(() => expect(diagnosticCount(view().state)).toBe(1));

    host.schema.set(undefined);
    await fixture.whenStable();
    expect(diagnosticCount(view().state)).toBe(0);
  });

  it('builds the editor schema only from a complete introspection', () => {
    expect(clientSchema(undefined)).toBeUndefined();
    expect(clientSchema({ types: [] })).toBeUndefined();
    expect(clientSchema({ types: [], introspection: 'not an introspection' })).toBeUndefined();
    expect(clientSchema(shop)?.getQueryType()?.name).toBe('Query');
    // A server that leaves parts out, as many do, still gives one.
    const partial = clientSchema(readSchema(JSON.stringify(introspection)));
    expect(partial?.getQueryType()?.getFields()['user']?.type.toString()).toBe('User');
  });

  it('inserts into the value before the editor exists', () => {
    const lone = TestBed.runInInjectionContext(() => new GraphqlQueryEditor());
    lone.value.set('query {}');
    lone.insert('user');
    expect(lone.value()).toContain('user');
    expect(lone.editor()).toBeUndefined();
  });
});
