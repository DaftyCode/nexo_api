import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BLOCK_OPERATORS, BlockOperator, Group } from '../domain/mongo-filter-builder';
import type { BlockPath, FilterBuilder } from './mongo-explorer/blocks';

const OPERATOR_LABELS: Record<BlockOperator, string> = {
  $eq: 'equals',
  $ne: 'is not',
  $gt: 'greater than',
  $gte: 'at least',
  $lt: 'less than',
  $lte: 'at most',
  $in: 'is one of',
  $nin: 'is none of',
  $exists: 'exists',
  $regex: 'matches',
};

/**
 * A group of filter blocks: whether all or any must hold, its conditions (field, operator,
 * value) and its groups, shown the same way inside.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mongo-filter-blocks',
  styleUrl: './mongo-explorer.scss',
  templateUrl: './mongo-filter-blocks.html',
})
export class MongoFilterBlocks {
  readonly builder = input.required<FilterBuilder>();
  readonly group = input.required<Group>();
  readonly path = input<BlockPath>([]);
  protected readonly operators = BLOCK_OPERATORS;
  protected readonly labels = OPERATOR_LABELS;

  protected text(event: Event) {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
  protected inner(index: number): BlockPath {
    return [...this.path(), index];
  }
}
