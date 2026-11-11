/**
 * MongoDB's explain, read as the stages a query runs through, in order, with what each one
 * returned and examined. The format changes between versions: plan trees of the classic
 * engine (`inputStage`, `inputStages`), the slot-based engine of 6.0 and later
 * (`winningPlan.queryPlan`, with its own execution stages tied to the plan by `planNodeId`),
 * aggregations (`stages`, with the query in `$cursor`) and sharded clusters (`shards`).
 */

/** A stage of a query plan, as the person reads it. */
export interface PlanStage {
  /** COLLSCAN, IXSCAN, FETCH, SORT, $group… */
  name: string;
  shard?: string;
  index?: string;
  /** Short facts about the stage, such as its keys or its sort; labels are message keys. */
  details: { label: string; value: string }[];
  returned?: number;
  docsExamined?: number;
  keysExamined?: number;
  ms?: number;
  /** A whole-collection scan, or a sort done in memory instead of with an index. */
  warning?: 'collscan' | 'memorySort';
}

/** An explain as a list of stages and its totals. */
export interface ExplainPlan {
  /** In the order they run: the first reads the collection, the last returns the results. */
  stages: PlanStage[];
  /** Whether the query ran to measure it (`executionStats`). */
  executed: boolean;
  returned?: number;
  docsExamined?: number;
  keysExamined?: number;
  ms?: number;
  /** Indexes the winning plan uses. */
  indexes: string[];
  collscan: boolean;
  memorySort: boolean;
  /** Other plans the planner considered. */
  rejectedPlans: number;
  engine: 'classic' | 'sbe';
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const node = (value: unknown): Node | undefined => (isNode(value) ? value : undefined);
const nodes = (value: unknown): Node[] => (Array.isArray(value) ? value.filter(isNode) : []);

/** A count, as relaxed Extended JSON writes it (a number, or `$numberLong` when large). */
function count(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const long = node(value)?.['$numberLong'] ?? node(value)?.['$numberInt'];
  if (typeof long === 'string' && long.trim() && Number.isFinite(Number(long))) return Number(long);
  return undefined;
}

/** A small value as the shell writes it: `{ status: 1, at: -1 }`. */
export function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
  if (isNode(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
    return `{ ${entries.map(([name, item]) => `${key(name)}: ${compact(item)}`).join(', ')} }`;
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** The inputs of a plan node, whatever the version calls them. */
function children(plan: Node): Node[] {
  return [
    ...nodes([plan['inputStage']]),
    ...nodes(plan['inputStages']),
    ...nodes([plan['outerStage'], plan['innerStage'], plan['thenStage'], plan['elseStage']]),
  ];
}

/** The facts worth showing of a classic plan node. */
function details(plan: Node): PlanStage['details'] {
  const facts: PlanStage['details'] = [];
  const add = (label: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '')
      facts.push({ label, value: compact(value) });
  };
  add('Keys', plan['keyPattern']);
  if (plan['direction'] && plan['direction'] !== 'forward') add('Direction', plan['direction']);
  add('Sort', plan['sortPattern']);
  add('Filter', plan['filter']);
  add('Limit', plan['limitAmount']);
  add('Skip', plan['skipAmount']);
  if (plan['usedDisk'] === true) facts.push({ label: 'Used disk', value: '✓' });
  return facts;
}

function warning(name: string): PlanStage['warning'] {
  if (name === 'COLLSCAN') return 'collscan';
  if (name === 'SORT' || name === '$sort') return 'memorySort';
  return undefined;
}

/** A plan node as a stage; `stats` gives what it measured when it is not on the node. */
function stage(plan: Node, shard: string | undefined, stats: Partial<PlanStage> = {}): PlanStage {
  const name = String(plan['stage'] ?? '?');
  const index = plan['indexName'] ?? (name === 'IDHACK' ? '_id_' : undefined);
  const result: PlanStage = {
    name,
    details: details(plan),
    returned: count(plan['nReturned']),
    docsExamined: count(plan['docsExamined']),
    keysExamined: count(plan['keysExamined']),
    ms: count(plan['executionTimeMillisEstimate']),
    ...stats,
  };
  if (shard) result.shard = shard;
  if (typeof index === 'string') result.index = index;
  const flagged = warning(name);
  if (flagged) result.warning = flagged;
  for (const key of ['returned', 'docsExamined', 'keysExamined', 'ms'] as const)
    if (result[key] === undefined) delete result[key];
  return result;
}

/**
 * The stages of a plan tree in the order they run: inputs first. A node with `shards` runs
 * on each shard, then merges.
 */
function flatten(
  plan: Node | undefined,
  shard: string | undefined,
  measure: (plan: Node) => Partial<PlanStage> = () => ({}),
): PlanStage[] {
  if (!plan) return [];
  const shards = nodes(plan['shards']);
  const below = shards.length
    ? shards.flatMap((part) =>
        flatten(
          node(part['executionStages']) ?? node(part['winningPlan']),
          String(part['shardName'] ?? ''),
          measure,
        ),
      )
    : children(plan).flatMap((input) => flatten(input, shard, measure));
  // A winning plan of the slot-based engine keeps the readable plan in `queryPlan`.
  if (!plan['stage'] && isNode(plan['queryPlan']))
    return [...below, ...flatten(plan['queryPlan'], shard, measure)];
  return [...below, stage(plan, shard, measure(plan))];
}

/**
 * What the slot-based engine measured for each node of the readable plan, by `planNodeId`:
 * the first (outermost) of its execution stages says what it returned and how long it took,
 * and they all add up what they examined.
 */
function slotStats(executionStages: Node | undefined): Map<number, Partial<PlanStage>> {
  const measured = new Map<number, Partial<PlanStage>>();
  const visit = (stage: Node) => {
    const id = count(stage['planNodeId']);
    if (id !== undefined) {
      const known = measured.get(id);
      const keys = count(stage['keysExamined']) ?? 0;
      const docs =
        count(stage['docsExamined']) ??
        (stage['stage'] === 'seek' || stage['stage'] === 'scan' ? count(stage['numReads']) : 0) ??
        0;
      if (!known)
        measured.set(id, {
          returned: count(stage['nReturned']),
          ms: count(stage['executionTimeMillisEstimate']),
          ...(keys ? { keysExamined: keys } : {}),
          ...(docs ? { docsExamined: docs } : {}),
        });
      else {
        if (keys) known.keysExamined = (known.keysExamined ?? 0) + keys;
        if (docs) known.docsExamined = (known.docsExamined ?? 0) + docs;
      }
    }
    children(stage).forEach(visit);
  };
  if (executionStages) visit(executionStages);
  return measured;
}

/** The stages and totals of a query's planner and execution sections. */
function query(
  planner: Node | undefined,
  execution: Node | undefined,
): Omit<ExplainPlan, 'indexes' | 'collscan' | 'memorySort'> {
  const winning = node(planner?.['winningPlan']);
  const sbe = isNode(winning?.['queryPlan']);
  const executionStages = node(execution?.['executionStages']);
  let stages: PlanStage[];
  if (sbe) {
    const measured = slotStats(executionStages);
    stages = flatten(winning, undefined, (plan) => {
      const id = count(plan['planNodeId']);
      return id === undefined ? {} : (measured.get(id) ?? {});
    });
  } else {
    // The classic engine's execution stages are the plan itself, measured.
    stages = flatten(executionStages ?? winning, undefined);
  }
  return {
    stages,
    executed: !!execution,
    returned: count(execution?.['nReturned']),
    docsExamined: count(execution?.['totalDocsExamined']),
    keysExamined: count(execution?.['totalKeysExamined']),
    ms: count(execution?.['executionTimeMillis']),
    rejectedPlans: nodes(planner?.['rejectedPlans']).length,
    engine: sbe ? 'sbe' : 'classic',
  };
}

/** An explain as the stages its query runs through, and its totals. */
export function explainPlan(explain: unknown): ExplainPlan {
  const root = node(explain) ?? {};
  let plan: Omit<ExplainPlan, 'indexes' | 'collscan' | 'memorySort'>;
  const pipeline = nodes(root['stages']);
  if (pipeline.length) {
    // An aggregation: its query (`$cursor`), then each stage of the pipeline the query could
    // not absorb. Times of the pipeline's stages include those before them.
    const cursor = node(pipeline[0]['$cursor']);
    plan = query(node(cursor?.['queryPlanner']), node(cursor?.['executionStats']));
    for (const part of pipeline.slice(cursor ? 1 : 0)) {
      const name = Object.keys(part).find((key) => key.startsWith('$')) ?? '?';
      const measured = stage({ stage: name }, undefined, {
        returned: count(part['nReturned']),
        ms: count(part['executionTimeMillisEstimate']),
      });
      if (part['usedDisk'] === true) measured.details.push({ label: 'Used disk', value: '✓' });
      if (name === '$sort' && isNode(part[name]))
        measured.details.push({ label: 'Sort', value: compact(node(part[name])?.['sortKey']) });
      plan.stages.push(measured);
    }
    const last = plan.stages.at(-1);
    plan.executed ||= pipeline.some((part) => part['nReturned'] !== undefined);
    if (plan.executed) {
      plan.returned = last?.returned ?? plan.returned;
      plan.ms = Math.max(plan.ms ?? 0, last?.ms ?? 0);
    }
  } else {
    plan = query(node(root['queryPlanner']), node(root['executionStats']));
  }
  const indexes = [...new Set(plan.stages.flatMap((s) => (s.index ? [s.index] : [])))];
  return {
    ...plan,
    indexes,
    collscan: plan.stages.some((s) => s.warning === 'collscan'),
    memorySort: plan.stages.some((s) => s.warning === 'memorySort'),
  };
}

/** Documents examined for each one returned: 1 is ideal, a large number needs an index. */
export function examinedRatio(plan: ExplainPlan): number | undefined {
  if (!plan.executed || plan.docsExamined === undefined) return undefined;
  const examined = Math.max(plan.docsExamined, plan.keysExamined ?? 0);
  return plan.returned ? examined / plan.returned : examined ? Infinity : 0;
}
