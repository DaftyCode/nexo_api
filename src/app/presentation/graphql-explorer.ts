import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  GraphQLSchema,
  SchemaField,
  fieldSnippet,
  schemaType,
  searchSchema,
} from '../domain/graphql-schema';

/**
 * The schema of a GraphQL endpoint, as Postman's schema explorer: the root operations, each
 * type with its fields and arguments, a search, and fields inserted into the query.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-graphql-explorer',
  styleUrl: './graphql-explorer.scss',
  templateUrl: './graphql-explorer.html',
})
export class GraphqlExplorer {
  readonly schema = input<GraphQLSchema | undefined>(undefined);
  readonly loading = input(false);
  /** "Load schema": introspection of the endpoint. */
  readonly loadSchema = output<void>();
  /** Text to insert into the query at the cursor. */
  readonly insert = output<string>();
  protected readonly search = signal('');
  /** Types opened, the current one last, for "Back". */
  protected readonly trail = signal<string[]>([]);
  protected readonly roots = computed(() => {
    const schema = this.schema();
    if (!schema) return [];
    return [
      { label: 'Query', name: schema.queryType },
      { label: 'Mutation', name: schema.mutationType },
      { label: 'Subscription', name: schema.subscriptionType },
    ].filter((root): root is { label: string; name: string } => !!root.name);
  });
  protected readonly current = computed(() => {
    const schema = this.schema();
    return schema && schemaType(schema, this.trail().at(-1) ?? schema.queryType);
  });
  protected readonly results = computed(() => {
    const schema = this.schema();
    return schema ? searchSchema(schema, this.search()) : [];
  });

  constructor() {
    // A schema of another endpoint starts at its root query.
    effect(() => {
      this.schema();
      untracked(() => {
        this.trail.set([]);
        this.search.set('');
      });
    });
  }
  protected open(name: string) {
    const schema = this.schema();
    if (!schema || !schemaType(schema, name)) return;
    this.search.set('');
    this.trail.update((trail) => (trail.at(-1) === name ? trail : [...trail, name]));
  }
  protected back() {
    this.trail.update((trail) => trail.slice(0, -1));
  }
  protected find(event: Event) {
    this.search.set((event.target as HTMLInputElement).value);
  }
  protected add(field: SchemaField) {
    const schema = this.schema();
    if (schema) this.insert.emit(fieldSnippet(schema, field));
  }
  protected signature(field: SchemaField) {
    const args = field.args.map((arg) => `${arg.name}: ${arg.type}`).join(', ');
    return `${field.name}${args ? `(${args})` : ''}${field.type ? `: ${field.type}` : ''}`;
  }
  /** Types whose fields can be opened from a field. */
  protected opens(field: SchemaField) {
    const schema = this.schema();
    const target = schema && schemaType(schema, field.typeName);
    return !!target && target.kind !== 'SCALAR';
  }
}
