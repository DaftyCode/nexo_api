/**
 * Monitors (`monitor` documents): a collection, or one of its folders, run on a schedule
 * while Nexo is open, with an environment and iteration data. The backend schedules them
 * and keeps the last runs of each one in its history (`monitor-history`).
 */
import { CollectionItem } from './models';

/** Minutes a monitor can run every: those that divide an hour (as the backend checks). */
export const EVERY_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
/** Hours a monitor can run every: those that divide a day, from midnight. */
export const EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
/** Runs the history of a monitor keeps. */
export const MONITOR_HISTORY_LIMIT = 100;

export type ScheduleUnit = 'minutes' | 'hours' | 'cron';

/** A monitor as its form edits it. */
export interface MonitorForm {
  name: string;
  collection: string;
  /** A folder of the collection, by id; empty runs the whole collection. */
  folder: string;
  environment: string;
  unit: ScheduleUnit;
  /** Minutes or hours, as the select gives them. */
  every: string;
  cron: string;
  iterations: number;
  delay: number;
  /** Iteration data, a JSON array as typed. */
  data: string;
  /** A system notification when a run fails. */
  notify: boolean;
  /** Sends changes in an environment that asks before them (a monitor cannot ask). */
  allowChanges: boolean;
}

export interface Monitor extends MonitorForm {
  id: string;
  paused: boolean;
}

/** One run in the history of a monitor. */
export interface MonitorRun {
  startedAt: number;
  duration: number;
  trigger: 'schedule' | 'manual';
  state: 'passed' | 'failed' | 'error' | 'skipped';
  requests: number;
  failedRequests: number;
  passedAssertions: number;
  failedAssertions: number;
  failures: { request?: string; assertion?: string; error?: string }[];
  error?: string;
}

/** What a monitor is doing now, from `monitor.status`. */
export interface MonitorLive {
  id: string;
  running: boolean;
  startedAt?: number;
  /** When it runs next (milliseconds since the epoch); none when paused or never. */
  next: number | null;
}
/** A run that finished, in any workspace, to notify it. */
export interface MonitorEvent {
  sequence: number;
  workspace: string;
  monitor: string;
  name: string;
  state: MonitorRun['state'];
  notify: boolean;
  failedAssertions?: number;
  failedRequests?: number;
  error?: string;
}
export interface MonitorStatus {
  monitors: MonitorLive[];
  finished: MonitorEvent[];
  sequence: number;
  /** Whether the scheduler runs (it does while Nexo is open). */
  scheduler: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function emptyMonitorForm(collection = ''): MonitorForm {
  return {
    name: '',
    collection,
    folder: '',
    environment: '',
    unit: 'minutes',
    every: '15',
    cron: '0 9 * * 1-5',
    iterations: 1,
    delay: 0,
    data: '',
    notify: true,
    allowChanges: false,
  };
}

/** A monitor from its document; anything else reads as none. */
export function readMonitor(document: {
  id: string;
  kind: string;
  name: string;
  value?: unknown;
}): Monitor | undefined {
  if (document.kind !== 'monitor') return undefined;
  const value = record(document.value);
  const schedule = record(value['schedule']);
  const cron = text(schedule['cron']);
  const unit: ScheduleUnit = cron ? 'cron' : schedule['unit'] === 'hours' ? 'hours' : 'minutes';
  const data = Array.isArray(value['data']) ? value['data'] : [];
  return {
    ...emptyMonitorForm(),
    id: document.id,
    name: document.name,
    collection: text(value['collection']),
    folder: text(value['folder']),
    environment: text(value['environment']),
    unit,
    every: String(number(schedule['every'], 15)),
    cron: cron || emptyMonitorForm().cron,
    iterations: number(value['iterations'], 1),
    delay: number(value['delay'], 0),
    data: data.length ? JSON.stringify(data, null, 2) : '',
    paused: value['paused'] === true,
    notify: value['notify'] === true,
    allowChanges: value['allowChanges'] === true,
  };
}

/** The form of a monitor that exists. */
export function monitorForm(monitor: Monitor): MonitorForm {
  const { id: _id, paused: _paused, ...form } = monitor;
  return form;
}

function iterationData(text: string): unknown[] | undefined {
  if (!text.trim()) return [];
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Why the form cannot be saved yet, as a message to translate; none when it can. */
export function monitorProblem(form: MonitorForm): string | undefined {
  if (!form.collection) return 'Choose the collection to run';
  if (form.unit === 'cron' && form.cron.trim().split(/\s+/).length !== 5)
    return 'Write the cron expression as five fields: minute hour day month weekday';
  if (!iterationData(form.data)) return 'Iteration data must be a JSON array';
  return undefined;
}

/** The value of a monitor's document, with only what is set. */
export function monitorValue(form: MonitorForm, paused: boolean): Record<string, unknown> {
  const data = iterationData(form.data);
  if (!data) throw new Error('Iteration data must be a JSON array');
  const valid = (form.unit === 'hours' ? EVERY_HOURS : EVERY_MINUTES) as readonly number[];
  const every = valid.includes(Number(form.every)) ? Number(form.every) : valid[0];
  return {
    collection: form.collection,
    ...(form.folder ? { folder: form.folder } : {}),
    ...(form.environment ? { environment: form.environment } : {}),
    schedule: form.unit === 'cron' ? { cron: form.cron.trim() } : { every, unit: form.unit },
    iterations: Math.min(Math.max(Math.round(Number(form.iterations) || 1), 1), 1000),
    ...(form.delay > 0 ? { delay: Math.min(Math.round(form.delay), 60_000) } : {}),
    ...(data.length ? { data } : {}),
    paused,
    notify: form.notify,
    allowChanges: form.allowChanges,
  };
}

/** The schedule as a message to translate with its values. */
export function scheduleText(monitor: Pick<MonitorForm, 'unit' | 'every' | 'cron'>): {
  key: string;
  params: Record<string, string>;
} {
  if (monitor.unit === 'cron') return { key: 'monitor.cron', params: { v0: monitor.cron } };
  const key = monitor.unit === 'hours' ? 'monitor.everyHours' : 'monitor.everyMinutes';
  return { key, params: { v0: String(monitor.every) } };
}

/** The folders of a collection that can be run alone: those with an id, by path. */
export function collectionFolders(
  items: readonly CollectionItem[] | undefined,
  prefix = '',
): { id: string; path: string }[] {
  return (items ?? []).flatMap((item) => {
    if (!item.item) return [];
    const path = prefix ? `${prefix} / ${item.name}` : item.name;
    const own = item.id ? [{ id: item.id, path }] : [];
    return [...own, ...collectionFolders(item.item, path)];
  });
}

/** The runs of a history document, newest first. */
export function readMonitorHistory(value: unknown): MonitorRun[] {
  const runs = record(value)['runs'];
  if (!Array.isArray(runs)) return [];
  return runs.map((run) => {
    const entry = record(run);
    const state = entry['state'];
    return {
      startedAt: number(entry['startedAt'], 0),
      duration: number(entry['duration'], 0),
      trigger: entry['trigger'] === 'manual' ? 'manual' : 'schedule',
      state:
        state === 'passed' || state === 'failed' || state === 'skipped'
          ? state
          : ('error' as const),
      requests: number(entry['requests'], 0),
      failedRequests: number(entry['failedRequests'], 0),
      passedAssertions: number(entry['passedAssertions'], 0),
      failedAssertions: number(entry['failedAssertions'], 0),
      failures: Array.isArray(entry['failures'])
        ? entry['failures'].map((failure) => {
            const f = record(failure);
            return {
              ...(f['request'] ? { request: text(f['request']) } : {}),
              ...(f['assertion'] ? { assertion: text(f['assertion']) } : {}),
              ...(f['error'] ? { error: text(f['error']) } : {}),
            };
          })
        : [],
      ...(entry['error'] ? { error: text(entry['error']) } : {}),
    };
  });
}

/** Runs that finished badly and whose monitor asks to be told. */
export function failuresToNotify(events: readonly MonitorEvent[]): MonitorEvent[] {
  return events.filter(
    (event) => event.notify && (event.state === 'failed' || event.state === 'error'),
  );
}
