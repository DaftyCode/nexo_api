// The GraphQL schema the end-to-end tests' local API answers.
/** A small GraphQL schema, as introspection answers it. */
const scalar = (name) => ({ kind: 'SCALAR', name, ofType: null });
export const introspection = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: null,
      subscriptionType: { name: 'Subscription' },
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              description: 'A user by ID',
              args: [{ name: 'id', type: { kind: 'NON_NULL', name: null, ofType: scalar('ID') } }],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Subscription',
          fields: [{ name: 'ticks', args: [], type: scalar('Int') }],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [{ name: 'name', args: [], type: scalar('String') }],
        },
        scalar('ID'),
        scalar('Int'),
        scalar('String'),
      ],
    },
  },
};
