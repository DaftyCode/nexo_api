/** Names of the types of CSV columns, and of those a cell failed to be, as message keys. */
export const TYPE_LABELS: Record<string, string> = {
  auto: 'Detect',
  string: 'Text',
  int: 'Int32',
  long: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  bool: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  json: 'JSON',
  skip: 'Skip column',
  number: 'Number',
};
