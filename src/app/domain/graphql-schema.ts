/**
 * GraphQL schemas read by introspection, summarized for the schema explorer: types with
 * their fields, arguments, descriptions and deprecations.
 */

/** The standard introspection query (as GraphiQL and Postman send it), without directives. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { name }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
}`;

export interface SchemaArgument {
  name: string;
  description: string;
  /** As written in GraphQL: `[ID!]!`. */
  type: string;
  defaultValue?: string;
}
export interface SchemaField {
  name: string;
  description: string;
  type: string;
  /** The named type under lists and non-nulls, to open it. */
  typeName: string;
  args: SchemaArgument[];
  deprecated?: string;
}
export interface SchemaType {
  name: string;
  kind: string;
  description: string;
  /** Fields of objects and interfaces, input fields of input objects, values of enums. */
  fields: SchemaField[];
}
export interface GraphQLSchema {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  /** Without the introspection types (`__Schema`, `__Type`…). */
  types: SchemaType[];
  /** The introspection answer as it came (`{__schema}`), for the query editor. */
  introspection?: unknown;
}

/** A type reference of an introspection answer. */
export interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}
type Raw = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown) => (Array.isArray(value) ? (value as Raw[]) : []);

/** A type reference as GraphQL writes it. */
export function typeLabel(ref: TypeRef | null | undefined): string {
  if (!ref) return '';
  if (ref.kind === 'NON_NULL') return `${typeLabel(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeLabel(ref.ofType)}]`;
  return ref.name ?? '';
}
function namedType(ref: TypeRef | null | undefined): string {
  return ref?.ofType ? namedType(ref.ofType) : (ref?.name ?? '');
}
function deprecation(raw: Raw): string | undefined {
  return raw['isDeprecated'] === true ? text(raw['deprecationReason']) || 'Deprecated' : undefined;
}
function argument(raw: Raw): SchemaArgument {
  const type = raw['type'] as TypeRef;
  return {
    name: text(raw['name']),
    description: text(raw['description']),
    type: typeLabel(type),
    ...(typeof raw['defaultValue'] === 'string' ? { defaultValue: raw['defaultValue'] } : {}),
  };
}
function field(raw: Raw): SchemaField {
  const type = raw['type'] as TypeRef;
  const deprecated = deprecation(raw);
  return {
    name: text(raw['name']),
    description: text(raw['description']),
    type: typeLabel(type),
    typeName: namedType(type),
    args: list(raw['args']).map(argument),
    ...(deprecated ? { deprecated } : {}),
  };
}

/**
 * Reads the body of an introspection response. Fails with the server's own GraphQL error, or
 * says that the answer is not a schema.
 */
export function readSchema(body: string): GraphQLSchema {
  let parsed: Raw;
  try {
    parsed = JSON.parse(body) as Raw;
  } catch {
    throw new Error('The server did not answer with a GraphQL schema');
  }
  const errors = list(parsed?.['errors']);
  const schema = (parsed?.['data'] as Raw | undefined)?.['__schema'] as Raw | undefined;
  if (!schema) {
    const message = text(errors[0]?.['message']);
    throw new Error(
      message
        ? `Introspection failed: ${message}`
        : 'The server did not answer with a GraphQL schema',
    );
  }
  const root = (key: string) => text((schema[key] as Raw | null)?.['name']) || undefined;
  const types = list(schema['types'])
    .filter((type) => !text(type['name']).startsWith('__'))
    .map((type): SchemaType => {
      const kind = text(type['kind']);
      const fields =
        kind === 'ENUM'
          ? list(type['enumValues']).map((value) => {
              const deprecated = deprecation(value);
              return {
                name: text(value['name']),
                description: text(value['description']),
                type: '',
                typeName: '',
                args: [],
                ...(deprecated ? { deprecated } : {}),
              };
            })
          : list(kind === 'INPUT_OBJECT' ? type['inputFields'] : type['fields']).map(field);
      return { name: text(type['name']), kind, description: text(type['description']), fields };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    queryType: root('queryType'),
    mutationType: root('mutationType'),
    subscriptionType: root('subscriptionType'),
    types,
    introspection: { __schema: schema },
  };
}

/**
 * The introspection with the parts some servers leave out filled in empty (interfaces,
 * possible types, directives, descriptions, standard scalars…), so an editor can build a
 * schema from it.
 * Anything that is not an introspection is returned as it is.
 */
export function completeIntrospection(introspection: unknown): unknown {
  const schema = (introspection as Raw | null)?.['__schema'] as Raw | undefined;
  if (!schema || !Array.isArray(schema['types'])) return introspection;
  const argument = (raw: Raw) => ({ description: null, defaultValue: null, ...raw });
  const field = (raw: Raw) => ({
    description: null,
    isDeprecated: false,
    deprecationReason: null,
    ...raw,
    args: list(raw['args']).map(argument),
  });
  const types = list(schema['types']).map((type) => {
    const kind = text(type['kind']);
    const filled: Raw = { description: null, ...type };
    if (kind === 'OBJECT' || kind === 'INTERFACE') {
      filled['fields'] = list(type['fields']).map(field);
      filled['interfaces'] = list(type['interfaces']);
    }
    if (kind === 'INTERFACE' || kind === 'UNION')
      filled['possibleTypes'] = list(type['possibleTypes']);
    if (kind === 'ENUM')
      filled['enumValues'] = list(type['enumValues']).map((value) => ({
        description: null,
        isDeprecated: false,
        deprecationReason: null,
        ...value,
      }));
    if (kind === 'INPUT_OBJECT') filled['inputFields'] = list(type['inputFields']).map(argument);
    return filled;
  });
  // The standard scalars, which some servers use without listing.
  for (const name of ['String', 'Boolean', 'Int', 'Float', 'ID'])
    if (!types.some((type) => type['name'] === name))
      types.push({ kind: 'SCALAR', name, description: null });
  return {
    __schema: { mutationType: null, subscriptionType: null, directives: [], ...schema, types },
  };
}

/** The type of that name, if the schema has it. */
export function schemaType(schema: GraphQLSchema, name: string | undefined) {
  return name ? schema.types.find((type) => type.name === name) : undefined;
}

/** Types and fields whose name or description contains the text, types first. */
export function searchSchema(schema: GraphQLSchema, query: string, limit = 50) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches = (value: string) => value.toLowerCase().includes(needle);
  const results: { type: SchemaType; field?: SchemaField }[] = [];
  for (const type of schema.types)
    if (matches(type.name) || matches(type.description)) results.push({ type });
  for (const type of schema.types)
    for (const item of type.fields)
      if (matches(item.name) || matches(item.description)) results.push({ type, field: item });
  return results.slice(0, limit);
}

/**
 * What inserting a field writes: its name, its arguments as variables to fill in, and braces
 * when its type has fields of its own.
 */
export function fieldSnippet(schema: GraphQLSchema, item: SchemaField): string {
  const args = item.args.length
    ? `(${item.args.map((arg) => `${arg.name}: $${arg.name}`).join(', ')})`
    : '';
  const target = schemaType(schema, item.typeName);
  const selection =
    target && ['OBJECT', 'INTERFACE', 'UNION'].includes(target.kind) ? ' {\n  \n}' : '';
  return `${item.name}${args}${selection}`;
}

/** Text with the snippet inserted at the cursor, and where the cursor goes after it. */
export function insertAt(value: string, cursor: number, snippet: string) {
  const at = Math.max(0, Math.min(cursor, value.length));
  const before = value.slice(0, at);
  const spacer = before && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${spacer}${snippet}${value.slice(at)}`;
  // Inside the braces, when there are any, ready to choose the fields.
  const braces = snippet.indexOf('{\n');
  return {
    value: next,
    cursor: at + spacer.length + (braces >= 0 ? braces + 4 : snippet.length),
  };
}
