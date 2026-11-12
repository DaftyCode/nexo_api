import { effect, signal, untracked } from '@angular/core';
import {
  Block,
  BlockError,
  Condition,
  Group,
  blocksFilter,
  emptyCondition,
  emptyGroup,
  filterBlocks,
} from '../../domain/mongo-filter-builder';
import type { MongoExplorer } from '../mongo-explorer';

/** Where a block is: the positions of its groups from the outermost one. */
export type BlockPath = readonly number[];

/**
 * The filter of the query bar as blocks, both ways: editing the blocks writes the filter in
 * the shell syntax, and a filter typed by hand shows as blocks when they can show it.
 */
export class FilterBuilder {
  readonly open = signal(false);
  readonly group = signal<Group>(emptyGroup());
  /** Why the blocks do not show the filter, or why they cannot write it, as a message key. */
  readonly problem = signal('');
  /** The filter the blocks last wrote, so writing it is not read back. */
  private written = '';

  constructor(private readonly explorer: MongoExplorer) {
    effect(() => {
      const text = explorer.model().filter;
      if (!untracked(() => this.open()) || text === this.written) return;
      untracked(() => this.read(text));
    });
  }

  private read(text: string) {
    const group = filterBlocks(text);
    if (group) {
      this.group.set(group);
      this.problem.set('');
    } else this.problem.set('mongo.blocks.unreadable');
  }
  toggle() {
    if (this.open()) return this.open.set(false);
    this.written = '';
    this.read(this.explorer.model().filter);
    this.open.set(true);
  }
  /** Leaves a filter the blocks cannot show and starts the blocks empty. */
  restart() {
    this.write(emptyGroup());
  }

  private write(group: Group) {
    this.group.set(group);
    try {
      const text = blocksFilter(group);
      this.written = text;
      this.explorer.model.update((model) => ({ ...model, filter: text }));
      this.problem.set('');
    } catch (error) {
      if (!(error instanceof BlockError)) throw error;
      this.problem.set(error.key);
    }
  }
  /** The group with the block at `path` changed by `change`. */
  private changed(
    group: Group,
    path: BlockPath,
    change: (block: Block) => Block | undefined,
  ): Group {
    const [index, ...rest] = path;
    const items = group.items.flatMap((item, i) => {
      if (i !== index) return [item];
      const next =
        rest.length && item.kind === 'group' ? this.changed(item, rest, change) : change(item);
      return next ? [next] : [];
    });
    return { ...group, items };
  }
  private at(path: BlockPath, change: (block: Block) => Block | undefined) {
    this.write(
      path.length ? this.changed(this.group(), path, change) : (change(this.group()) as Group),
    );
  }

  setCondition(path: BlockPath, change: Partial<Omit<Condition, 'kind'>>) {
    this.at(path, (block) => (block.kind === 'condition' ? { ...block, ...change } : block));
  }
  setJoin(path: BlockPath, join: Group['join']) {
    this.at(path, (block) => (block.kind === 'group' ? { ...block, join } : block));
  }
  add(path: BlockPath, kind: Block['kind']) {
    const block =
      kind === 'group' ? { ...emptyGroup(), items: [emptyCondition()] } : emptyCondition();
    this.at(path, (group) =>
      group.kind === 'group' ? { ...group, items: [...group.items, block] } : group,
    );
  }
  remove(path: BlockPath) {
    this.at(path, () => undefined);
  }
}
