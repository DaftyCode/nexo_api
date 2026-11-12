import { parseUpdate } from '../domain/mongo-write';
import type { WriteDialog } from './mongo-writes';

/** Writes to every document the filter of the query bar matches, after counting them. */
/** How many documents the query bar's filter matches now. */
async function matching(dialog: WriteDialog, filter: Record<string, unknown>) {
  const cases = await dialog.context.cases();
  const target = dialog.context.target();
  if (!target) throw new Error('Choose a collection');
  return cases.queries.count(...dialog.scope, target, { filter }, crypto.randomUUID());
}
/** Updates every document the filter matches, after counting them. */
export function updateMany(dialog: WriteDialog) {
  dialog.run(() => countThenUpdate(dialog));
}
async function countThenUpdate(dialog: WriteDialog) {
  const filter = dialog.context.filter();
  if (!filter) return;
  const count = await matching(dialog, filter);
  dialog.ask(
    {
      title: 'Update many documents',
      message: { key: 'mongo.willUpdate', params: { v0: count } },
      editor: { label: 'Update', value: "{ $set: { field: 'value' } }" },
      confirm: 'Update documents',
      danger: true,
    },
    async ({ text }) => {
      const cases = await dialog.context.cases();
      const answer = await cases.writes.update(
        ...dialog.scope,
        dialog.where(),
        filter,
        parseUpdate(text),
        count,
      );
      await dialog.written(answer);
      return 'Documents updated';
    },
  );
}

/** Deletes every document the filter matches, after counting them. */
export function deleteMany(dialog: WriteDialog, everything: boolean) {
  dialog.run(() => countThenDelete(dialog, everything));
}
async function countThenDelete(dialog: WriteDialog, everything: boolean) {
  const filter = everything ? {} : dialog.context.filter();
  if (!filter) return;
  const count = await matching(dialog, filter);
  const collection = dialog.context.target()?.collection ?? '';
  const all = !Object.keys(filter).length;
  dialog.ask(
    {
      title: all ? 'Empty collection' : 'Delete many documents',
      message: { key: 'mongo.willDelete', params: { v0: count } },
      ...(all ? { confirmName: collection } : {}),
      confirm: 'Delete documents',
      danger: true,
    },
    async () => {
      const cases = await dialog.context.cases();
      const answer = await cases.writes.deleteDocuments(...dialog.scope, dialog.where(), filter, {
        expected: count,
        ...(all ? { confirm: collection } : {}),
      });
      await dialog.written(answer);
      return 'Documents deleted';
    },
  );
}
