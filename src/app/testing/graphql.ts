import { TypeRef } from '../domain/graphql-schema';

export const named = (kind: string, name: string): TypeRef => ({ kind, name, ofType: null });
export const nonNull = (ofType: TypeRef): TypeRef => ({ kind: 'NON_NULL', name: null, ofType });
export const listOf = (ofType: TypeRef): TypeRef => ({ kind: 'LIST', name: null, ofType });

/** An introspection answer as GraphQL servers write it. */
export const introspection = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          description: 'Entry points',
          fields: [
            {
              name: 'user',
              description: 'A user by ID',
              args: [
                {
                  name: 'id',
                  description: '',
                  type: nonNull(named('SCALAR', 'ID')),
                  defaultValue: null,
                },
              ],
              type: named('OBJECT', 'User'),
              isDeprecated: false,
              deprecationReason: null,
            },
            {
              name: 'users',
              description: null,
              args: [],
              type: nonNull(listOf(nonNull(named('OBJECT', 'User')))),
              isDeprecated: true,
              deprecationReason: 'Use search',
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            {
              name: 'rename',
              args: [
                { name: 'input', type: nonNull(named('INPUT_OBJECT', 'RenameInput')) },
                { name: 'notify', type: named('SCALAR', 'Boolean'), defaultValue: 'false' },
              ],
              type: named('SCALAR', 'Boolean'),
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          description: 'Someone who signs in',
          fields: [
            { name: 'id', args: [], type: nonNull(named('SCALAR', 'ID')) },
            { name: 'role', args: [], type: named('ENUM', 'Role') },
          ],
        },
        {
          kind: 'INPUT_OBJECT',
          name: 'RenameInput',
          inputFields: [{ name: 'name', type: nonNull(named('SCALAR', 'String')) }],
        },
        {
          kind: 'ENUM',
          name: 'Role',
          enumValues: [
            { name: 'ADMIN', description: 'Everything', isDeprecated: false },
            { name: 'GUEST', isDeprecated: true, deprecationReason: null },
          ],
        },
        { kind: 'SCALAR', name: 'ID' },
        { kind: 'OBJECT', name: '__Schema', fields: [] },
      ],
    },
  },
};
