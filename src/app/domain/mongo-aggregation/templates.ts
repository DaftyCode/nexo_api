/**
 * The stage operators offered when a stage is added, each with the value it starts with, in
 * the shell's syntax. Any other operator can be typed.
 */
export const STAGE_TEMPLATES: Readonly<Record<string, string>> = {
  $match: "{\n  status: 'A'\n}",
  $project: '{\n  _id: 0,\n  name: 1\n}',
  $addFields: "{\n  total: { $sum: '$items.qty' }\n}",
  $set: "{\n  total: { $sum: '$items.qty' }\n}",
  $unset: "['field']",
  $group: "{\n  _id: '$status',\n  count: { $sum: 1 }\n}",
  $sort: '{\n  count: -1\n}',
  $limit: '20',
  $skip: '10',
  $unwind: "{\n  path: '$items',\n  preserveNullAndEmptyArrays: false\n}",
  $lookup:
    "{\n  from: 'collection',\n  localField: 'field',\n  foreignField: '_id',\n  as: 'joined'\n}",
  $graphLookup:
    "{\n  from: 'collection',\n  startWith: '$parent',\n  connectFromField: 'parent',\n  connectToField: '_id',\n  as: 'ancestors'\n}",
  $unionWith: "{\n  coll: 'collection'\n}",
  $facet: "{\n  first: [{ $limit: 5 }],\n  byStatus: [{ $sortByCount: '$status' }]\n}",
  $count: "'total'",
  $sortByCount: "'$status'",
  $bucket:
    "{\n  groupBy: '$price',\n  boundaries: [0, 100, 200],\n  default: 'other',\n  output: { count: { $sum: 1 } }\n}",
  $bucketAuto: "{\n  groupBy: '$price',\n  buckets: 4\n}",
  $replaceRoot: "{\n  newRoot: '$customer'\n}",
  $replaceWith: "'$customer'",
  $sample: '{\n  size: 10\n}',
  $setWindowFields:
    "{\n  partitionBy: '$status',\n  sortBy: { at: 1 },\n  output: {\n    running: { $sum: 1, window: { documents: ['unbounded', 'current'] } }\n  }\n}",
  $out: "'collection'",
  $merge:
    "{\n  into: 'collection',\n  on: '_id',\n  whenMatched: 'replace',\n  whenNotMatched: 'insert'\n}",
};

export const STAGE_OPERATORS = Object.keys(STAGE_TEMPLATES);
