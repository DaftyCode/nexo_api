/**
 * The execution plan of a statement, as every driver answers it (`db.explain`): a tree of
 * nodes with their operation, object, index, condition, estimated rows and cost and, in the
 * actual mode, the rows and time measured; and the plan as the engine wrote it. Here, the
 * rows of its tree with the bar of each node, and the warnings worth reading first.
 */
export type PlanMode = 'estimated' | 'actual';

export interface PlanNode {
  operation: string;
  object?: string;
  index?: string;
  condition?: string;
  estimatedRows?: number;
  estimatedCost?: number;
  /** Rows of one loop, as the estimate counts them. */
  actualRows?: number;
  /** Milliseconds, with what the node holds. */
  actualMs?: number;
  loops?: number;
  memoryKb?: number;
  /** `full-scan`, `disk-sort`, `temporary`. */
  flags?: string[];
  details?: Record<string, string>;
  children?: PlanNode[];
}

export interface ExplainPlan {
  mode: PlanMode;
  nodes: PlanNode[];
  /** How `original` is written: `json`, `xml` or `text`. */
  format: string;
  original: string;
  totalMs?: number;
  /** The actual plan of a change: what it changed was rolled back. */
  rolledBack?: boolean;
}

/** A row of the plan's tree. */
export interface PlanRow {
  /** Its place: `0`, `0.1`, `0.1.0`… */
  id: string;
  depth: number;
  node: PlanNode;
  parent: boolean;
  /** Its share of the plan's time (actual) or cost (estimated), from 0 to 1. */
  share: number;
}

/** A table this big read whole is worth a warning. */
export const BIG_TABLE = 1000;
/** Estimates this far from what happened are worth a warning. */
export const MISESTIMATE = 10;
/** A node run this many times is worth a warning. */
export const MANY_LOOPS = 1000;

function walk(
  nodes: readonly PlanNode[],
  visit: (node: PlanNode, id: string, depth: number) => boolean,
  prefix = '',
  depth = 0,
) {
  nodes.forEach((node, at) => {
    const id = prefix ? `${prefix}.${at}` : `${at}`;
    if (visit(node, id, depth)) walk(node.children ?? [], visit, id, depth + 1);
  });
}

/** What the bars measure: the time of each node when it was measured, else its cost. */
function measureOf(plan: ExplainPlan): (node: PlanNode) => number | undefined {
  let timed = false;
  walk(plan.nodes, (node) => {
    timed ||= node.actualMs !== undefined;
    return !timed;
  });
  return timed ? (node) => node.actualMs : (node) => node.estimatedCost;
}

/** The rows of the tree, without the ones under a collapsed node. */
export function planRows(plan: ExplainPlan, collapsed: ReadonlySet<string> = new Set()): PlanRow[] {
  const measure = measureOf(plan);
  let most = 0;
  walk(plan.nodes, (node) => {
    most = Math.max(most, measure(node) ?? 0);
    return true;
  });
  const rows: PlanRow[] = [];
  walk(plan.nodes, (node, id, depth) => {
    rows.push({
      id,
      depth,
      node,
      parent: !!node.children?.length,
      share: most > 0 ? Math.min(1, (measure(node) ?? 0) / most) : 0,
    });
    return !collapsed.has(id);
  });
  return rows;
}

export interface PlanWarning {
  /** A message key. */
  text: string;
  params: Record<string, string>;
  /** The row it is about. */
  id: string;
}

const rowsOf = (node: PlanNode) => node.actualRows ?? node.estimatedRows;
const named = (node: PlanNode) => node.object ?? node.operation;
const count = (value: number) => String(Math.round(value));

/**
 * What to look at first, as DBeaver and the engines' own tools warn: a big table read whole,
 * a sort on disk, an estimate ten times off what happened, a node run very many times, and a
 * temporary table.
 */
export function planWarnings(plan: ExplainPlan): PlanWarning[] {
  const found: PlanWarning[] = [];
  walk(plan.nodes, (node, id) => {
    const flags = node.flags ?? [];
    const rows = rowsOf(node);
    const removed = Number(node.details?.['Rows Removed by Filter'] ?? 0);
    if (flags.includes('full-scan') && (rows === undefined || rows + removed >= BIG_TABLE))
      found.push({ text: 'db.plan.fullScan', params: { v0: named(node) }, id });
    if (flags.includes('disk-sort'))
      found.push({ text: 'db.plan.diskSort', params: { v0: node.operation }, id });
    if (flags.includes('temporary'))
      found.push({ text: 'db.plan.temporary', params: { v0: node.operation }, id });
    const { actualRows: actual, estimatedRows: estimated } = node;
    if (actual !== undefined && estimated !== undefined) {
      const [low, high] = [Math.min(actual, estimated), Math.max(actual, estimated)];
      if (high >= 100 && high / Math.max(low, 1) >= MISESTIMATE)
        found.push({
          text: 'db.plan.misestimate',
          params: { v0: named(node), v1: count(estimated), v2: count(actual) },
          id,
        });
    }
    if ((node.loops ?? 0) >= MANY_LOOPS)
      found.push({
        text: 'db.plan.loops',
        params: { v0: named(node), v1: count(node.loops ?? 0) },
        id,
      });
    return true;
  });
  return found;
}

/** Every node of the plan, for counting them. */
export function planSize(plan: ExplainPlan): number {
  let size = 0;
  walk(plan.nodes, () => {
    size++;
    return true;
  });
  return size;
}
