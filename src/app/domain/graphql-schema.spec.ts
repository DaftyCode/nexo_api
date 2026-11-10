import {
  GraphQLSchema,
  INTROSPECTION_QUERY,
  completeIntrospection,
  fieldSnippet,
  insertAt,
  readSchema,
  schemaType,
  searchSchema,
  typeLabel,
} from './graphql-schema';
import { introspection, listOf, named, nonNull } from '../testing/graphql';

describe('GraphQL schemas', () => {
  let schema: GraphQLSchema;
  beforeEach(() => {
    schema = readSchema(JSON.stringify(introspection));
  });

  it('asks for every type with its fields, arguments and deprecations', () => {
    for (const part of ['__schema', 'queryType', 'subscriptionType', 'includeDeprecated: true'])
      expect(INTROSPECTION_QUERY).toContain(part);
  });

  it('summarizes types, fields, arguments and deprecations', () => {
    expect(schema.queryType).toBe('Query');
    expect(schema.mutationType).toBe('Mutation');
    expect(schema.subscriptionType).toBeUndefined();
    expect(schema.types.map((type) => type.name)).toEqual([
      'ID',
      'Mutation',
      'Query',
      'RenameInput',
      'Role',
      'User',
    ]);
    const query = schemaType(schema, 'Query')!;
    expect(query.description).toBe('Entry points');
    expect(query.fields[0]).toEqual({
      name: 'user',
      description: 'A user by ID',
      type: 'User',
      typeName: 'User',
      args: [{ name: 'id', description: '', type: 'ID!' }],
    });
    expect(query.fields[1]).toMatchObject({
      type: '[User!]!',
      typeName: 'User',
      deprecated: 'Use search',
    });
    expect(schemaType(schema, 'Mutation')!.fields[0].args[1].defaultValue).toBe('false');
    expect(schemaType(schema, 'RenameInput')!.fields.map((field) => field.type)).toEqual([
      'String!',
    ]);
    expect(schemaType(schema, 'Role')!.fields).toEqual([
      { name: 'ADMIN', description: 'Everything', type: '', typeName: '', args: [] },
      {
        name: 'GUEST',
        description: '',
        type: '',
        typeName: '',
        args: [],
        deprecated: 'Deprecated',
      },
    ]);
    expect(schemaType(schema, undefined)).toBeUndefined();
  });

  it('keeps the introspection, and fills the parts some servers leave out', () => {
    expect(readSchema(JSON.stringify(introspection)).introspection).toEqual(introspection.data);
    const filled = completeIntrospection({
      __schema: {
        queryType: { name: 'Query' },
        types: [
          { kind: 'OBJECT', name: 'Query', fields: [{ name: 'a', type: {} }] },
          { kind: 'INTERFACE', name: 'Node' },
          { kind: 'UNION', name: 'Any', possibleTypes: [{ kind: 'OBJECT', name: 'Query' }] },
          { kind: 'ENUM', name: 'Status', enumValues: [{ name: 'OPEN', isDeprecated: true }] },
          { kind: 'INPUT_OBJECT', name: 'Filter', inputFields: [{ name: 'q', type: {} }] },
          { kind: 'SCALAR', name: 'ID' },
        ],
      },
    }) as { __schema: Record<string, unknown> & { types: Record<string, unknown>[] } };
    expect(filled.__schema['directives']).toEqual([]);
    expect(filled.__schema['mutationType']).toBeNull();
    const [query, node, any, status, filter, id] = filled.__schema.types;
    expect(query).toMatchObject({
      interfaces: [],
      fields: [{ name: 'a', args: [], isDeprecated: false, description: null }],
    });
    expect(node).toMatchObject({ fields: [], interfaces: [], possibleTypes: [] });
    expect(any['possibleTypes']).toHaveLength(1);
    expect(status['enumValues']).toEqual([
      { name: 'OPEN', description: null, isDeprecated: true, deprecationReason: null },
    ]);
    expect(filter['inputFields']).toEqual([
      { name: 'q', type: {}, description: null, defaultValue: null },
    ]);
    expect(id).toEqual({ kind: 'SCALAR', name: 'ID', description: null });
    expect(filled.__schema.types.slice(6).map((type) => type['name'])).toEqual([
      'String',
      'Boolean',
      'Int',
      'Float',
    ]);
    for (const other of [undefined, null, 'x', { __schema: { types: 1 } }])
      expect(completeIntrospection(other)).toBe(other);
  });

  it('explains answers that are not a schema', () => {
    expect(() => readSchema('<html>')).toThrow('The server did not answer with a GraphQL schema');
    expect(() => readSchema('{"data": {}}')).toThrow(
      'The server did not answer with a GraphQL schema',
    );
    expect(() =>
      readSchema('{"errors": [{"message": "GraphQL introspection is not allowed"}]}'),
    ).toThrow('Introspection failed: GraphQL introspection is not allowed');
  });

  it('writes type references as GraphQL does', () => {
    expect(typeLabel(nonNull(listOf(named('SCALAR', 'Int'))))).toBe('[Int]!');
    expect(typeLabel(undefined)).toBe('');
  });

  it('finds types and fields by name or description', () => {
    const found = searchSchema(schema, 'user');
    expect(found.map((result) => `${result.type.name}.${result.field?.name ?? ''}`)).toEqual([
      'User.',
      'Query.user',
      'Query.users',
    ]);
    expect(searchSchema(schema, 'signs').map((result) => result.type.name)).toEqual(['User']);
    expect(searchSchema(schema, '  ')).toEqual([]);
    expect(searchSchema(schema, 'e', 2)).toHaveLength(2);
  });

  it('inserts fields with their arguments and a selection for object types', () => {
    const query = schemaType(schema, 'Query')!;
    expect(fieldSnippet(schema, query.fields[0])).toBe('user(id: $id) {\n  \n}');
    const user = schemaType(schema, 'User')!;
    expect(fieldSnippet(schema, user.fields[0])).toBe('id');
    expect(fieldSnippet(schema, user.fields[1])).toBe('role');

    const inserted = insertAt('query {\n  \n}', 10, 'user(id: $id) {\n  \n}');
    expect(inserted.value).toBe('query {\n  user(id: $id) {\n  \n}\n}');
    expect(inserted.value.slice(0, inserted.cursor)).toBe('query {\n  user(id: $id) {\n  ');
    expect(insertAt('{ a', 3, 'b')).toEqual({ value: '{ a b', cursor: 5 });
    expect(insertAt('', 99, 'id')).toEqual({ value: 'id', cursor: 2 });
  });
});
